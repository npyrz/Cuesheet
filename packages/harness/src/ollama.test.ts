/**
 * The `ollama` harness, tested against *captured* streams and a fake server.
 *
 * Four fixtures, all recorded off a real Ollama 0.32.9 on this machine:
 *
 * - `ollama-chat.jsonl` — `/api/chat` on `qwen3:0.6b` writing a commit
 *   message. 142 frames, thinking interleaved with content, a final `done`
 *   frame carrying the counts.
 * - `ollama-classify.jsonl` — the same endpoint with `"think": false`, which
 *   arrives as **two** frames. It is here because a mapper fitted to the first
 *   fixture alone would quietly assume a frame is a token.
 * - `ollama-error.json` — an unpulled model: HTTP 404, a JSON body, no stream.
 * - `ollama-tags.json` — the `/api/tags` document the probe reads.
 *
 * The server is faked rather than reached, for the reason every other harness
 * test fakes its subprocess: CI has no Ollama, and a suite that needs one is a
 * suite people skip. The live test at the bottom is gated on `CUESHEET_E2E=1`
 * like the `claude-code` and `codex` ones.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Station } from "@cuesheet/core";
import { harnessContractViolations, exerciseHarness } from "./contract.js";
import { createMeter } from "./meter.js";
import {
  createOllamaHarness,
  createOllamaState,
  listModels,
  mapOllamaEvent,
  ollamaHarness,
  parseTags,
  probeOllama,
  resolveHost,
  seatRefusal,
  OLLAMA_DEFAULT_HOST,
} from "./ollama.js";
import type { HarnessEvent } from "./types.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function loadLines(name: string): Promise<unknown[]> {
  const text = await readFile(fixture(name), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

async function raw(name: string): Promise<string> {
  return readFile(fixture(name), "utf8");
}

let commit: unknown[];
let classify: unknown[];
let tags: unknown;

beforeAll(async () => {
  [commit, classify, tags] = await Promise.all([
    loadLines("ollama-chat.jsonl"),
    loadLines("ollama-classify.jsonl"),
    readFile(fixture("ollama-tags.json"), "utf8").then(
      (text) => JSON.parse(text) as unknown,
    ),
  ]);
});

function station(overrides: Partial<Station> = {}): Station {
  return {
    id: "local",
    harness: "ollama",
    role: "worker",
    model: "qwen3:0.6b",
    workspace: "/tmp/scratch",
    paths: ["**"],
    deny: [".git/**", "**/*.env"],
    ...overrides,
  };
}

function mapAll(lines: unknown[]): {
  events: HarnessEvent[];
  state: ReturnType<typeof createOllamaState>;
} {
  const state = createOllamaState();
  const events: HarnessEvent[] = [];
  for (const line of lines) events.push(...mapOllamaEvent(line, state));
  return { events, state };
}

const textOf = (events: HarnessEvent[]): string =>
  events
    .filter((e): e is Extract<HarnessEvent, { t: "text" }> => e.t === "text")
    .map((e) => e.chunk)
    .join("");

// ── The contract ────────────────────────────────────────────────────────────

describe("the harness contract", () => {
  it("is satisfied", () => {
    expect(harnessContractViolations(ollamaHarness)).toEqual([]);
  });

  it("plays only the worker seat", () => {
    expect(ollamaHarness.roles).toEqual(["worker"]);
  });

  it("keeps no context file, which is the hole the Commons fills", () => {
    expect(ollamaHarness.contextFiles).toEqual([]);
  });

  it("declares read-only confinement for every seat", () => {
    // Understating rather than overstating: this runtime has no file path in
    // either direction. `"none"` would read on a surface as *less* confined
    // than Codex's reviewer, which would be backwards.
    expect(ollamaHarness.confinement?.("worker")).toBe("read-only");
    expect(ollamaHarness.confinement?.("engineer")).toBe("read-only");
  });

  it("reports an unmetered window rather than a percentage", async () => {
    expect(await ollamaHarness.usage()).toEqual([
      { window: "local", state: "unmetered" },
    ]);
  });
});

// ── The seat ────────────────────────────────────────────────────────────────

describe("the seat", () => {
  it("lets a worker through", () => {
    expect(seatRefusal(station())).toBeUndefined();
  });

  it.each(["reviewer", "engineer", "caller"] as const)(
    "refuses a %s by name",
    (role) => {
      const refusal = seatRefusal(station({ role }));
      expect(refusal).toContain("only plays worker");
      expect(refusal).toContain(role);
    },
  );

  it("refuses a reviewer without contacting the model", async () => {
    // The test that decides whether `roles: ["worker"]` is structural or
    // advisory. A reviewer seat must produce no request at all — a run that
    // asked and then discarded the answer would still have generated a
    // plausible-looking approval somewhere.
    let called = 0;
    const harness = createOllamaHarness({
      fetch: (async () => {
        called += 1;
        throw new Error("the model should never have been asked");
      }) as unknown as typeof fetch,
    });

    const result = await harness.run(
      context({ station: station({ role: "reviewer" }) }),
    );

    expect(called).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("manufactures confidence");
  });
});

// ── The stream ──────────────────────────────────────────────────────────────

describe("mapping the captured commit-message stream", () => {
  it("stitches the content back into what the model actually said", () => {
    const { events } = mapAll(commit);
    expect(textOf(events)).toBe("Add rate limiter to API gateway.");
  });

  it("drops the thinking and keeps its tokens", () => {
    const { events, state } = mapAll(commit);
    // 618 characters of scratchpad in the capture. None of it in the log.
    expect(textOf(events)).not.toContain("Okay");
    // ...but `eval_count` is 146 against 32 characters of content, so the
    // scratchpad is plainly inside the number, and a worker's cost is what it
    // cost.
    expect(state.total()).toEqual({ tokensIn: 36, tokensOut: 146, usd: 0 });
  });

  it("emits no newline of its own — frames are fragments, not lines", () => {
    const { events } = mapAll(commit);
    const chunks = events
      .filter((e): e is Extract<HarnessEvent, { t: "text" }> => e.t === "text")
      .map((e) => e.chunk);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.some((chunk) => chunk.includes("\n"))).toBe(false);
  });

  it("settles the counts on the done frame without emitting a cost event", () => {
    // The mapper records; the meter emits. Doing both put the same figure on
    // the wire twice — caught by the first real run through the daemon, which
    // carried two identical `cost` events a millisecond apart. The totals were
    // never wrong, but a Desk drawing the stream would show a free harness
    // costing double.
    const { events, state } = mapAll(commit);
    expect(events.filter((e) => e.t === "cost")).toEqual([]);
    expect(state.total()).toEqual({ tokensIn: 36, tokensOut: 146, usd: 0 });
  });

  it("prices a local run at zero rather than leaving it unknown", () => {
    // The one harness where a zero is a fact. `codex` leaves `usd` absent
    // because it cannot price a run; local inference has no marginal price.
    const { state } = mapAll(commit);
    expect(state.total().usd).toBe(0);
  });

  it("reports no cache breakdown, because nothing reported one", () => {
    const { state } = mapAll(commit);
    expect(state.total()).not.toHaveProperty("cacheRead");
    expect(state.total()).not.toHaveProperty("cacheWrite");
  });
});

describe("mapping the captured two-frame stream", () => {
  it("handles a whole answer arriving in one frame", () => {
    // `"think": false` collapses the stream to two frames. A mapper that
    // assumed one token per frame passes the other fixture and fails here.
    expect(classify).toHaveLength(2);
    const { events, state } = mapAll(classify);
    expect(textOf(events)).toBe("ui");
    expect(state.total()).toEqual({ tokensIn: 57, tokensOut: 2, usd: 0 });
  });
});

describe("mapping the awkward frames", () => {
  it("ignores anything that is not an object", () => {
    const state = createOllamaState();
    expect(mapOllamaEvent(null, state)).toEqual([]);
    expect(mapOllamaEvent("done", state)).toEqual([]);
    expect(mapOllamaEvent([1, 2], state)).toEqual([]);
  });

  it("does not emit an empty content field as an empty chunk", () => {
    // Every frame in the capture carries `content`, and most of them carry
    // `""`. Emitting those would put 100+ empty events on the wire per run.
    const state = createOllamaState();
    expect(
      mapOllamaEvent(
        { message: { role: "assistant", content: "", thinking: "Okay" } },
        state,
      ),
    ).toEqual([]);
  });

  it("surfaces an error frame and fails the run", () => {
    const state = createOllamaState();
    const events = mapOllamaEvent({ error: "model is gone" }, state);
    expect(events).toEqual([{ t: "text", chunk: "model is gone\n" }]);
    expect(state.errorMessage).toBe("model is gone");
  });

  it("says so when the model was cut off rather than finished", () => {
    // `done_reason: "length"` means a truncated answer. For a worker whose
    // whole output is one classification that is the difference between an
    // answer and half of one, and it must not look like a clean finish.
    const state = createOllamaState();
    const events = mapOllamaEvent(
      {
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "length",
        prompt_eval_count: 10,
        eval_count: 4096,
      },
      state,
    );
    expect(textOf(events)).toContain("stopped early: length");
  });

  it("stays quiet on a clean stop", () => {
    const { events } = mapAll(commit);
    expect(textOf(events)).not.toContain("stopped early");
  });
});

// ── The probe ───────────────────────────────────────────────────────────────

describe("parsing `/api/tags`", () => {
  it("reads the pulled models out of the captured document", () => {
    expect(parseTags(tags)).toEqual(["qwen3:0.6b"]);
  });

  it("sorts, so a pull does not reorder somebody's picker", () => {
    expect(
      parseTags({
        models: [{ name: "zephyr:7b" }, { name: "llama3.2:1b" }],
      }),
    ).toEqual(["llama3.2:1b", "zephyr:7b"]);
  });

  it("returns an empty list for a server with nothing pulled", () => {
    expect(parseTags({ models: [] })).toEqual([]);
  });

  it("does not throw on a shape it has never seen", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags({ models: "soon" })).toEqual([]);
    expect(parseTags({ models: [null, 3, { size: 1 }] })).toEqual([]);
  });
});

describe("resolving the host", () => {
  it("defaults to loopback by IP, never `localhost`", () => {
    // On Windows `localhost` resolves to `::1` first, and a server bound to
    // `0.0.0.0` answers `127.0.0.1` while refusing that. The probe would call
    // a running server dead.
    expect(resolveHost(undefined)).toBe(OLLAMA_DEFAULT_HOST);
    expect(resolveHost("")).toBe(OLLAMA_DEFAULT_HOST);
    expect(OLLAMA_DEFAULT_HOST).not.toContain("localhost");
  });

  it("adds a scheme to the bare `host:port` the CLI documents", () => {
    expect(resolveHost("127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(resolveHost("box.tail:11434")).toBe("http://box.tail:11434");
  });

  it("leaves an explicit scheme alone and strips a trailing slash", () => {
    expect(resolveHost("https://ollama.internal/")).toBe(
      "https://ollama.internal",
    );
  });
});

describe("probing", () => {
  it("reports a running server with the models actually pulled", async () => {
    const result = await probeOllama({
      host: "http://127.0.0.1:11434",
      bin: "ollama",
      which: async () => null,
      fetch: fakeServer({
        version: '{"version":"0.32.9"}',
        tags: await raw("ollama-tags.json"),
      }),
    });

    expect(result.installed).toBe(true);
    expect(result.authed).toBe(true);
    expect(result.version).toBe("0.32.9");
    expect(result.models).toEqual(["qwen3:0.6b"]);
    expect(result.error).toBeUndefined();
  });

  it("reports an empty model list as a real answer", async () => {
    // A running server with nothing pulled. `[]` and absent are different
    // claims, and the Desk needs to be able to say "nothing is pulled" rather
    // than fall back to a free-text box.
    const result = await probeOllama({
      host: "http://127.0.0.1:11434",
      bin: "ollama",
      which: async () => null,
      fetch: fakeServer({
        version: '{"version":"0.32.9"}',
        tags: '{"models":[]}',
      }),
    });
    expect(result.models).toEqual([]);
  });

  it("says start-it when the binary is there and nothing is listening", async () => {
    // The third state no other harness can be in, and the reason `probeOllama`
    // exists as its own function. Telling this operator to *install* Ollama
    // would be telling them to download something they already have.
    const result = await probeOllama({
      host: "http://127.0.0.1:11434",
      bin: "ollama",
      fetch: fakeServer({ refuse: true }),
      which: async () => "C:\\Program Files\\Ollama\\ollama.exe",
    });

    expect(result.installed).toBe(true);
    expect(result.authed).toBe(false);
    expect(result.error).toContain("installed but nothing is listening");
    expect(result.error).toContain("ollama serve");
  });

  it("says install-it when there is no binary and no server", async () => {
    const result = await probeOllama({
      host: "http://127.0.0.1:11434",
      bin: "ollama",
      fetch: fakeServer({ refuse: true }),
      which: async () => null,
    });

    expect(result.installed).toBe(false);
    expect(result.error).toContain("not on your PATH");
    // A remote server is a supported configuration, so the message says so
    // rather than assuming the operator wants a local install.
    expect(result.error).toContain("OLLAMA_HOST");
  });

  it("asks the server before the PATH, so a remote host is not called dead", async () => {
    // Probing the binary first would report a perfectly good `OLLAMA_HOST` on
    // another machine as uninstalled, because there is no binary on this one.
    let looked = 0;
    const result = await probeOllama({
      host: "http://box.tail:11434",
      bin: "ollama",
      fetch: fakeServer({
        version: '{"version":"0.32.9"}',
        tags: await raw("ollama-tags.json"),
      }),
      which: async () => {
        looked += 1;
        return null;
      },
    });

    expect(looked).toBe(0);
    expect(result.installed).toBe(true);
  });

  it("never throws, whatever the server does", async () => {
    const result = await probeOllama({
      host: "http://127.0.0.1:11434",
      bin: "ollama",
      which: async () => null,
      fetch: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(result.installed).toBe(false);
  });

  it("keeps the model list absent when `/api/tags` fails", async () => {
    // Absent means "I could not ask", which is a different claim from "[]".
    const result = await probeOllama({
      host: "http://127.0.0.1:11434",
      bin: "ollama",
      which: async () => null,
      fetch: fakeServer({ version: '{"version":"0.32.9"}', tagsStatus: 500 }),
    });
    expect(result.models).toBeUndefined();
    expect(result.error).toContain("no model list");
  });

  it("rejects rather than returning [] when the list cannot be read", async () => {
    await expect(
      listModels("http://127.0.0.1:11434", fakeServer({ tagsStatus: 500 })),
    ).rejects.toThrow("500");
  });
});

// ── Running ─────────────────────────────────────────────────────────────────

describe("running", () => {
  it("streams the captured run through to a done result", async () => {
    const harness = createOllamaHarness({
      fetch: fakeServer({ chat: await raw("ollama-chat.jsonl") }),
    });
    const events: HarnessEvent[] = [];
    const result = await harness.run(
      context({ onEvent: (e) => events.push(e) }),
    );

    expect(result.status).toBe("done");
    expect(textOf(events)).toBe("Add rate limiter to API gateway.");
    expect(result.cost).toEqual({ tokensIn: 36, tokensOut: 146, usd: 0 });
  });

  it("puts the cost on the wire exactly once", async () => {
    const harness = createOllamaHarness({
      fetch: fakeServer({ chat: await raw("ollama-chat.jsonl") }),
    });
    const events: HarnessEvent[] = [];
    await harness.run(context({ onEvent: (e) => events.push(e) }));
    expect(events.filter((e) => e.t === "cost")).toHaveLength(1);
  });

  it("returns no diff, even though it could ask for one", async () => {
    // A worker that returned `workspace.diff()` would attribute somebody
    // else's changes in a shared workspace to the one Station that cannot make
    // any — and here the attribution would be provably wrong, because this
    // harness has no write path at all.
    const harness = createOllamaHarness({
      fetch: fakeServer({ chat: await raw("ollama-chat.jsonl") }),
    });
    const result = await harness.run(context());
    expect(result.diff).toBeUndefined();
  });

  it("touches zero files", async () => {
    const touched: string[] = [];
    const harness = createOllamaHarness({
      fetch: fakeServer({ chat: await raw("ollama-chat.jsonl") }),
    });
    const events: HarnessEvent[] = [];
    await harness.run(
      context({
        onEvent: (e) => {
          events.push(e);
          if (e.t === "file") touched.push(e.path);
        },
        onWrite: (path) => touched.push(path),
      }),
    );
    expect(touched).toEqual([]);
    expect(events.some((e) => e.t === "file")).toBe(false);
  });

  it("chunks the body at arbitrary boundaries without losing a frame", async () => {
    // The bug this prevents: a JSON frame straddles two network chunks and
    // `JSON.parse` is handed half an object. 7 bytes is chosen to split
    // mid-frame many times over.
    const harness = createOllamaHarness({
      fetch: fakeServer({
        chat: await raw("ollama-chat.jsonl"),
        chunkBytes: 7,
      }),
    });
    const events: HarnessEvent[] = [];
    const result = await harness.run(
      context({ onEvent: (e) => events.push(e) }),
    );
    expect(result.status).toBe("done");
    expect(textOf(events)).toBe("Add rate limiter to API gateway.");
  });

  it("reports an unpulled model as the sentence Ollama wrote", async () => {
    const harness = createOllamaHarness({
      fetch: fakeServer({
        chatStatus: 404,
        chat: await raw("ollama-error.json"),
      }),
    });
    const result = await harness.run(
      context({ station: station({ model: "not-a-real-model:7b" }) }),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("model 'not-a-real-model:7b' not found");
  });

  it("refuses a Station with no model, and names what is pulled", async () => {
    // No silent fallback to "the first model on the machine": that is the same
    // Station producing different work on two boxes. The list goes in the
    // error, where it is actionable.
    const harness = createOllamaHarness({
      fetch: fakeServer({ tags: await raw("ollama-tags.json") }),
    });
    const result = await harness.run(
      context({ station: { ...station(), model: undefined } }),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no `model`");
    expect(result.error).toContain("qwen3:0.6b");
  });

  it("says start-it rather than crashing when nothing is listening", async () => {
    const harness = createOllamaHarness({
      fetch: fakeServer({ refuse: true }),
    });
    const result = await harness.run(context());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Could not reach Ollama");
  });

  it("lands `stopped`, not `failed`, when the run is stopped", async () => {
    const controller = new AbortController();
    const harness = createOllamaHarness({
      fetch: fakeServer({
        chat: await raw("ollama-chat.jsonl"),
        chunkBytes: 40,
        onChunk: (index) => {
          if (index === 2) controller.abort();
        },
      }),
    });
    const result = await harness.run(context({ signal: controller.signal }));
    expect(result.status).toBe("stopped");
  });
});

describe("the contract exerciser", () => {
  it("passes against a fake server", async () => {
    const harness = createOllamaHarness({
      fetch: fakeServer({
        chat: await raw("ollama-chat.jsonl"),
        version: '{"version":"0.32.9"}',
        tags: await raw("ollama-tags.json"),
      }),
    });
    const report = await exerciseHarness(harness, { station: station() });
    expect(report.violations).toEqual([]);
  });
});

// ── Live ────────────────────────────────────────────────────────────────────

describe.runIf(process.env["CUESHEET_E2E"] === "1")(
  "against a real Ollama",
  () => {
    it("probes a running server", async () => {
      const probe = await ollamaHarness.probe();
      expect(probe.installed).toBe(true);
      expect(probe.authed).toBe(true);
      expect(Array.isArray(probe.models)).toBe(true);
    }, 30_000);

    it("runs a worker cue and spends real tokens", async () => {
      const probe = await ollamaHarness.probe();
      const model = probe.models?.[0];
      if (model === undefined) return; // Nothing pulled; nothing to assert.
      const events: HarnessEvent[] = [];
      const result = await ollamaHarness.run(
        context({
          station: station({ model }),
          brief: "Reply with the single word: ok",
          onEvent: (e) => events.push(e),
        }),
      );
      expect(result.status).toBe("done");
      expect(result.cost?.tokensOut).toBeGreaterThan(0);
      expect(result.cost?.usd).toBe(0);
      expect(textOf(events).length).toBeGreaterThan(0);
    }, 180_000);
  },
);

// ── Test doubles ────────────────────────────────────────────────────────────

interface FakeServerOptions {
  chat?: string;
  chatStatus?: number;
  version?: string;
  tags?: string;
  tagsStatus?: number;
  /** Split the chat body into pieces of this size, to straddle frames. */
  chunkBytes?: number;
  onChunk?: (index: number) => void;
  /** Nothing is listening. */
  refuse?: boolean;
}

/**
 * A fetch that answers the three routes this harness knows.
 *
 * A stub rather than a real listener: what is under test is the mapping and
 * the branching, and a real socket would add a port to every case for no extra
 * coverage. The one thing it does model faithfully is chunking — the body
 * arrives in pieces that do not respect frame boundaries, which is the bug the
 * line reader exists to prevent.
 */
function fakeServer(options: FakeServerOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (options.refuse) {
      const error = new TypeError("fetch failed");
      throw error;
    }

    if (url.endsWith("/api/version")) {
      return jsonResponse(options.version ?? '{"version":"0.0.0"}', 200);
    }

    if (url.endsWith("/api/tags")) {
      if (options.tagsStatus !== undefined && options.tagsStatus !== 200) {
        return jsonResponse("{}", options.tagsStatus);
      }
      return jsonResponse(options.tags ?? '{"models":[]}', 200);
    }

    const status = options.chatStatus ?? 200;
    const body = options.chat ?? "";
    if (status !== 200) return jsonResponse(body, status);

    return new Response(
      chunkedStream(body, options.chunkBytes, options.onChunk, init?.signal),
      { status: 200, headers: { "content-type": "application/x-ndjson" } },
    );
  }) as unknown as typeof fetch;
}

function jsonResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chunkedStream(
  body: string,
  chunkBytes: number | undefined,
  onChunk: ((index: number) => void) | undefined,
  signal: AbortSignal | null | undefined,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  const size = chunkBytes ?? bytes.length;
  let offset = 0;
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted === true) {
        const error = new Error("The run was stopped.");
        error.name = "AbortError";
        controller.error(error);
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
      onChunk?.(index);
      index += 1;
    },
  });
}

interface ContextOptions {
  station?: Station;
  brief?: string;
  signal?: AbortSignal;
  onEvent?: (event: HarnessEvent) => void;
  onWrite?: (path: string) => void;
}

/**
 * A `RunContext` whose workspace fails loudly if it is ever touched.
 *
 * Not a permissive stub: the claim this harness makes is that it never reads
 * or writes a file, and a facade that quietly answered would let a regression
 * through the one test that is supposed to catch it.
 */
function context(options: ContextOptions = {}) {
  const emit = options.onEvent ?? (() => undefined);

  const forbidden = (what: string) => (): never => {
    throw new Error(`\`ollama\` must never ${what} the workspace.`);
  };

  return {
    runId: "run_test",
    stationId: options.station?.id ?? "local",
    station: options.station ?? station(),
    brief: options.brief ?? "Write a commit message.",
    signal: options.signal ?? new AbortController().signal,
    emit,
    // The real meter, not a counter. It is what actually puts a `cost` event
    // on the wire, and a stub that only accumulated would have let the
    // duplicate-cost bug through the one test written to catch it.
    meter: createMeter({ emit }),
    ask: async () => {
      throw new Error("`ollama` must never raise a standby.");
    },
    workspace: {
      path: "/tmp/scratch",
      check: async () => ({ allowed: true }),
      read: forbidden("read"),
      write: (path: string) => {
        options.onWrite?.(path);
        return forbidden("write")();
      },
      exists: async () => false,
      list: forbidden("list"),
      diff: forbidden("diff"),
    },
  } as unknown as Parameters<typeof ollamaHarness.run>[0];
}
