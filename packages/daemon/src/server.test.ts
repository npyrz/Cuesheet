import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { HostEnv, Run, RunEvent, Standby, Station } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import {
  createFileRunStore,
  type RunDetailResponse,
  type StoredRun,
} from "./store.js";
import { createRunIdFactory } from "./ids.js";
import type { RunExecutor } from "./executor.js";
import type { StopOutcome } from "./queue.js";
import type { StationsResponse } from "./stations.js";

const CONFIG = `
[desk]
name = "Test Desk"

[[station]]
id = "opus"
harness = "claude-code"
role = "engineer"
model = "opus"
workspace = "/tmp/ws"
paths = ["src/**"]
deny = [".git/**"]

[[station]]
id = "sonnet"
harness = "claude-code"
role = "reviewer"
workspace = "/tmp/ws"

[cuesheet.ship]
cues = [
  { station = "opus", action = "implement" },
  { gate = "default" },
  { station = "sonnet", action = "review" },
]

[gate.default]
require = "1-of-1"

[limits]
warn_at = 0.85
`;

let env: HostEnv;
let cwd: string;
let root: string;
let daemon: DaemonHandle;

async function boot(executor?: RunExecutor): Promise<DaemonHandle> {
  // `port: 0` binds an ephemeral port, so these files can run in parallel
  // vitest workers without fighting each other or a dev daemon on 7373.
  daemon = await startDaemon({
    port: 0,
    env,
    cwd,
    writeLockFile: false,
    store: createFileRunStore({ root, newId: createRunIdFactory() }),
    ...(executor && { executor }),
  });
  return daemon;
}

const done: RunExecutor = () =>
  Promise.resolve({
    status: "done" as const,
    cost: { tokensIn: 0, tokensOut: 0 },
    durationMs: 0,
  });

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cuesheet-home-"));
  env = { platform: process.platform, homedir: home };
  cwd = await mkdtemp(path.join(tmpdir(), "cuesheet-cwd-"));
  root = await mkdtemp(path.join(tmpdir(), "cuesheet-runs-"));
  await writeFile(path.join(cwd, "cuesheet.toml"), CONFIG, "utf8");
});

afterEach(async () => {
  await daemon?.close();
});

/**
 * Typed against the real exported response shapes rather than `any`, so these
 * smoke tests also fail to compile if a route's contract changes underneath
 * them — the Desk and the phone are the other consumers of exactly these types.
 */
interface Response_<T> {
  status: number;
  body: T;
}

async function get<T = unknown>(url: string, p: string): Promise<Response_<T>> {
  const response = await fetch(`${url}${p}`);
  return { status: response.status, body: (await response.json()) as T };
}

async function post<T = unknown>(
  url: string,
  p: string,
  body?: unknown,
): Promise<Response_<T>> {
  const response = await fetch(`${url}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

interface Health {
  ok: true;
  version: string;
}
interface Enqueued {
  runId: string;
}
interface RunList {
  runs: Run[];
}
interface Stopped {
  runId: string;
  outcome: StopOutcome;
}
interface Answered {
  standby: Standby;
}
interface ApiError {
  error: string;
}

describe("GET /health", () => {
  it("returns ok and a version", async () => {
    // Step 8's done-when, against a real listening server.
    const { url } = await boot();
    const { status, body } = await get<Health>(url, "/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, version: expect.any(String) });
  });

  it("reports the port it actually bound", async () => {
    const handle = await boot();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
  });

  it("is also served under /api, for the Vite dev proxy", async () => {
    const { url } = await boot();
    // Step 17's dev server proxies `/api` and `/ws`. Serving both prefixes
    // beats a rewrite rule and keeps `curl :7373/health` working.
    expect((await get<Health>(url, "/api/health")).body).toEqual({
      ok: true,
      version: expect.any(String),
    });
  });
});

describe("GET /stations", () => {
  it("returns configured stations with probe results", async () => {
    const { url } = await boot();
    const { status, body } = await get<StationsResponse>(url, "/stations");
    expect(status).toBe(200);

    const stations = body.stations as Array<{
      station: { id: string };
      probe: unknown;
    }>;
    expect(stations.map((s) => s.station.id)).toEqual(["opus", "sonnet"]);
    expect(stations[0]?.probe).toMatchObject({
      harness: "claude-code",
      installed: false,
    });
  });

  it("surfaces the loader's warnings for unimplemented tables", async () => {
    // Step 6 collects these precisely so this route can report them; without
    // it a user never learns their `[limits]` table is parsed but not live.
    // This used to assert on `[gate]`, which is implemented now.
    const { url } = await boot();
    const { body } = await get<StationsResponse>(url, "/stations");
    const warnings = body.warnings as Array<{
      table?: string;
      message: string;
    }>;
    expect(warnings.some((w) => w.table === "limits")).toBe(true);
    expect(warnings.some((w) => w.message.includes("Usage limits"))).toBe(true);
    // And the gate table no longer warns at all.
    expect(warnings.some((w) => w.table === "gate")).toBe(false);
  });

  it("reports which file the config came from", async () => {
    const { url } = await boot();
    const { body } = await get<StationsResponse>(url, "/stations");
    expect(body.sourcePath).toBe(path.join(cwd, "cuesheet.toml"));
  });

  it("lists every known harness, installed first", async () => {
    const { url } = await boot();
    const { body } = await get<StationsResponse>(url, "/stations");
    const harnesses = body.harnesses as Array<{ harness: string }>;
    // Step 20's panel renders installed harnesses first and greys out the rest.
    expect(harnesses.map((h) => h.harness)).toContain("codex");
    expect(harnesses.map((h) => h.harness)).toContain("ollama");
  });

  it("still answers when there is no config file at all", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "cuesheet-empty-"));
    daemon = await startDaemon({
      port: 0,
      env,
      cwd: empty,
      writeLockFile: false,
    });
    const { body } = await get<StationsResponse>(daemon.url, "/stations");
    expect(body.stations).toEqual([]);
    expect(body.sourcePath).toBeNull();
  });
});

describe("POST /runs", () => {
  it("enqueues a run and returns its id", async () => {
    const { url } = await boot(done);
    const { status, body } = await post<Enqueued>(url, "/runs", {
      prompt: "ship it",
    });
    expect(status).toBe(202);
    expect(body.runId).toMatch(/^\d{8}T\d{9}Z-\d{4}$/);
  });

  it("resolves the workspace and station from config", async () => {
    const { url } = await boot(done);
    const { body } = await post<Enqueued>(url, "/runs", { prompt: "ship it" });
    await daemon.queue.idle();

    const { body: stored } = await get<StoredRun>(url, `/runs/${body.runId}`);
    expect(stored.run.workspace).toBe("/tmp/ws");
    expect(stored.run.stationIds).toEqual(["opus"]);
  });

  it("expands a named cuesheet into its stations, skipping gate refs", async () => {
    const { url } = await boot(done);
    const { body } = await post<Enqueued>(url, "/runs", {
      prompt: "ship it",
      cuesheet: "ship",
    });
    await daemon.queue.idle();

    const { body: stored } = await get<StoredRun>(url, `/runs/${body.runId}`);
    // `{ gate = "default" }` is a cue kind, not a Station: it does not appear
    // in `stationIds`, which is the list of Stations the run touches. The
    // executor plans gates from the cuesheet itself.
    expect(stored.run.stationIds).toEqual(["opus", "sonnet"]);
    expect(stored.run.cuesheetId).toBe("ship");
  });

  it("rejects a missing or empty prompt", async () => {
    const { url } = await boot();
    expect((await post(url, "/runs", {})).status).toBe(400);
    expect((await post(url, "/runs", { prompt: "   " })).status).toBe(400);
    expect((await post(url, "/runs", { prompt: 42 })).status).toBe(400);
  });

  it("404s for an unknown cuesheet", async () => {
    const { url } = await boot();
    const { status } = await post(url, "/runs", {
      prompt: "hi",
      cuesheet: "nope",
    });
    expect(status).toBe(404);
  });
});

describe("GET /runs", () => {
  it("lists runs newest first", async () => {
    const { url } = await boot(done);
    const first = await post<Enqueued>(url, "/runs", { prompt: "one" });
    const second = await post<Enqueued>(url, "/runs", { prompt: "two" });
    await daemon.queue.idle();

    const { body } = await get<RunList>(url, "/runs");
    const runs = body.runs as Array<{ id: string; prompt: string }>;
    expect(runs.map((r) => r.id)).toEqual([
      second.body.runId,
      first.body.runId,
    ]);
    expect(runs[0]?.prompt).toBe("two");
  });

  it("is an empty list before anything has run", async () => {
    const { url } = await boot();
    expect((await get<RunList>(url, "/runs")).body.runs).toEqual([]);
  });

  it("honours ?limit=", async () => {
    const { url } = await boot(done);
    await post(url, "/runs", { prompt: "one" });
    await post(url, "/runs", { prompt: "two" });
    await daemon.queue.idle();
    expect((await get<RunList>(url, "/runs?limit=1")).body.runs).toHaveLength(
      1,
    );
  });
});

describe("GET /runs/:id", () => {
  it("returns the run plus its events", async () => {
    const { url } = await boot(async (ctx) => {
      ctx.emit({
        t: "text",
        at: new Date().toISOString(),
        runId: ctx.run.id,
        stationId: "opus",
        chunk: "working",
      });
      return done(ctx);
    });

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "ship it" });
    await daemon.queue.idle();

    const { status, body: stored } = await get<RunDetailResponse>(
      url,
      `/runs/${body.runId}`,
    );
    expect(status).toBe(200);
    expect(stored.run.status).toBe("done");
    const events = stored.events as RunEvent[];
    expect(events.some((e) => e.t === "text")).toBe(true);
    expect(events.some((e) => e.t === "done")).toBe(true);
  });

  it("404s for a well-formed id that does not exist", async () => {
    const { url } = await boot();
    expect((await get(url, "/runs/20260910T142233104Z-9999")).status).toBe(404);
  });

  it("400s a malformed id instead of letting it reach the filesystem", async () => {
    // A run id is a directory name, so an unvalidated param is a traversal.
    // Percent-encoded separators are the ones that matter: they survive the
    // client's URL normalization and arrive at the handler decoded.
    const { url } = await boot();
    for (const hostile of [
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "..%2f..%2fetc%2fpasswd",
      "not-an-id",
      "20260910T142233104Z",
      "20260910T142233104Z-1",
    ]) {
      const { status, body } = await get<ApiError>(url, `/runs/${hostile}`);
      expect(status, hostile).toBe(400);
      expect(body).toEqual({ error: "Malformed run id." });
    }
  });
});

describe("POST /runs/:id/stop", () => {
  it("stops a running run", async () => {
    const { url } = await boot(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "long one" });
    await new Promise((r) => setTimeout(r, 20));

    const stopped = await post<Stopped>(url, `/runs/${body.runId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.outcome).toBe("stopped-running");

    await daemon.queue.idle();
    const { body: stored } = await get<StoredRun>(url, `/runs/${body.runId}`);
    expect(stored.run.status).toBe("stopped");
  });

  it("404s an unknown run and 400s a malformed id", async () => {
    const { url } = await boot();
    expect(
      (await post(url, "/runs/20260910T142233104Z-9999/stop")).status,
    ).toBe(404);
    expect((await post(url, "/runs/nope/stop")).status).toBe(400);
  });
});

describe("POST /standbys/:id", () => {
  it("answers a waiting standby and resumes the run", async () => {
    let answer: string | undefined;
    const { url } = await boot(async (ctx) => {
      answer = await ctx.ask({ ask: "Write to infra/?", kind: "permission" });
      return done(ctx);
    });

    await post(url, "/runs", { prompt: "ship it" });
    await new Promise((r) => setTimeout(r, 20));

    const [pending] = daemon.standbys.list();
    expect(pending?.ask).toBe("Write to infra/?");

    const { status, body } = await post<Answered>(
      url,
      `/standbys/${pending!.id}`,
      { answer: "go" },
    );
    expect(status).toBe(200);
    expect(body.standby.answer).toBe("go");

    await daemon.queue.idle();
    expect(answer).toBe("go");
  });

  it("rejects an answer that is not go or no", async () => {
    const { url } = await boot();
    expect(
      (await post(url, "/standbys/sb_1", { answer: "maybe" })).status,
    ).toBe(400);
    expect((await post(url, "/standbys/sb_1", {})).status).toBe(400);
  });

  it("404s when nothing is waiting on that id", async () => {
    const { url } = await boot();
    expect(
      (await post(url, "/standbys/sb_nope", { answer: "go" })).status,
    ).toBe(404);
  });
});

describe("GET /ws", () => {
  /**
   * Open a socket, collecting messages from the moment it is constructed.
   *
   * The handler is attached synchronously, before `open` is awaited, for the
   * same reason `bus.attach` returns its backlog in one call: the server
   * writes the replay backlog the instant the upgrade completes, so a listener
   * attached after `await open` can miss frames that already arrived. A test
   * that awaits first passes or fails on loopback timing.
   */
  function listen(url: string) {
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    const events: RunEvent[] = [];
    let notify: (() => void) | null = null;

    socket.on("message", (data) => {
      events.push(JSON.parse(String(data)) as RunEvent);
      notify?.();
    });

    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    function until(
      predicate: (events: RunEvent[]) => boolean,
      timeoutMs = 3000,
    ): Promise<RunEvent[]> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!predicate(events)) return;
          clearTimeout(timer);
          notify = null;
          resolve(events);
        };
        const timer = setTimeout(() => {
          notify = null;
          reject(new Error(`timed out with ${events.length} events`));
        }, timeoutMs);
        notify = check;
        check();
      });
    }

    return { socket, events, opened, until };
  }

  it("streams events as JSON lines", async () => {
    // Step 9's done-when, with a real client over a real upgrade.
    const { url } = await boot(done);
    const client = listen(url);
    await client.opened;
    try {
      await post(url, "/runs", { prompt: "ship it" });
      const events = await client.until((e) => e.some((x) => x.t === "done"));

      expect(events.map((e) => e.t)).toContain("status");
      expect(events.map((e) => e.t)).toContain("done");
      expect(
        events.every(
          (e) => typeof e.runId === "string" && typeof e.at === "string",
        ),
      ).toBe(true);
    } finally {
      client.socket.close();
    }
  });

  it("replays a mid-run backlog to a client that connects late", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { url } = await boot(async (ctx) => {
      ctx.emit({
        t: "text",
        at: new Date().toISOString(),
        runId: ctx.run.id,
        stationId: "opus",
        chunk: "already happened",
      });
      await gate;
      return done(ctx);
    });

    await post(url, "/runs", { prompt: "ship it" });
    await new Promise((r) => setTimeout(r, 30));

    // Connecting mid-run must not leave the client staring at nothing.
    const client = listen(url);
    await client.opened;
    try {
      const backlogged = await client.until((e) =>
        e.some((x) => x.t === "text" && x.chunk === "already happened"),
      );
      expect(backlogged.some((e) => e.t === "status")).toBe(true);

      release();
      const events = await client.until((e) => e.some((x) => x.t === "done"));
      // No duplicate of the replayed event once the live stream takes over.
      expect(
        events.filter((e) => e.t === "text" && e.chunk === "already happened"),
      ).toHaveLength(1);
    } finally {
      client.socket.close();
    }
  });

  it("drops its subscription when the client disconnects", async () => {
    const { url } = await boot();
    const client = listen(url);
    await client.opened;
    expect(daemon.bus.subscriberCount()).toBeGreaterThan(0);

    client.socket.close();
    await new Promise((r) => setTimeout(r, 50));
    // A leaked subscriber per reconnect is how a long session dies.
    expect(daemon.bus.subscriberCount()).toBe(0);
  });

  it("is also reachable under the /api prefix", async () => {
    const { url } = await boot(done);
    const socket = new WebSocket(`${url.replace("http", "ws")}/api/ws`);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
    }
  });
});

describe("close", () => {
  it("stops serving and is idempotent", async () => {
    const handle = await boot();
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
  });

  it("closes with a WebSocket client still connected", async () => {
    // Every other test closes its socket first, so shutdown with a live
    // connection is otherwise unexercised — and if it ever blocks, the symptom
    // is a hung CI job with no failing assertion. Step 21 puts this exact
    // `close()` in Electron's `before-quit`, so it has to hold.
    const handle = await boot();
    const socket = new WebSocket(`${handle.url.replace("http", "ws")}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    await expect(handle.close()).resolves.toBeUndefined();
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
    socket.close();
  }, 10_000);

  it("marks a run interrupted when the daemon closes under it", async () => {
    const { url } = await boot(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "long one" });
    await new Promise((r) => setTimeout(r, 20));

    // A run caught by a shutdown must land somewhere terminal and readable,
    // never sit `running` forever.
    await daemon.close();

    const stored = await daemon.store.get(body.runId);
    expect(stored?.run.status).toBe("interrupted");
    expect(stored?.run.finishedAt).toBeTypeOf("string");
    expect(stored?.events.length).toBeGreaterThan(0);
  }, 10_000);
});

describe("GET /runs/:id/diff", () => {
  /**
   * Records a patch and finishes.
   *
   * `recordDiff` takes only the patch — the `DiffStat` rides on the returned
   * summary, which is what the `done` event carries. That split is the point:
   * the stat goes on the wire, the megabytes go to disk.
   */
  const withDiff = (patch: string): RunExecutor => {
    return async (ctx) => {
      ctx.recordDiff(patch);
      return {
        ...(await done(ctx)),
        diff: { filesChanged: 1, insertions: 2, deletions: 0 },
      };
    };
  };

  it("serves the patch as text", async () => {
    const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,2 @@\n+added\n";
    const { url } = await boot(withDiff(patch));

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "edit" });
    await daemon.queue.idle();

    const response = await fetch(`${url}/runs/${body.runId}/diff`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(patch);
  });

  it("keeps the patch out of GET /runs/:id, flagging it instead", async () => {
    // A workspace with a large untracked tree yields a multi-megabyte patch,
    // and this is the route the Desk calls to open a run row.
    const { url } = await boot(withDiff("--- a/x\n+++ b/x\n"));

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "edit" });
    await daemon.queue.idle();

    const { body: stored } = await get<RunDetailResponse & { diff?: string }>(
      url,
      `/runs/${body.runId}`,
    );
    expect(stored.hasDiff).toBe(true);
    expect(stored.diff).toBeUndefined();
  });

  it("404s when the run wrote no patch", async () => {
    const { url } = await boot(done);
    const { body } = await post<Enqueued>(url, "/runs", { prompt: "nothing" });
    await daemon.queue.idle();

    const { status } = await get(url, `/runs/${body.runId}/diff`);
    expect(status).toBe(404);

    const { body: stored } = await get<RunDetailResponse & { diff?: string }>(
      url,
      `/runs/${body.runId}`,
    );
    expect(stored.hasDiff).toBe(false);
  });

  it("400s a malformed id rather than reading an arbitrary path", async () => {
    const { url } = await boot();
    const { status } = await get(url, "/runs/..%2f..%2fetc/diff");
    expect(status).toBe(400);
  });
});

describe("POST /stations", () => {
  interface Added {
    station: Station;
    sourcePath: string;
    created: boolean;
    stations: StationsResponse;
  }

  /** A real directory, because the route stats the workspace it is given. */
  async function workspace(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "cuesheet-ws-"));
  }

  it("writes a [[station]] block to the loaded config and returns a new tile", async () => {
    // Step 20's done-when.
    const { url } = await boot();
    const ws = await workspace();

    const { status, body } = await post<Added>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: ws,
    });

    expect(status).toBe(201);
    expect(body.sourcePath).toBe(path.join(cwd, "cuesheet.toml"));
    expect(body.created).toBe(false);

    const text = await readFile(path.join(cwd, "cuesheet.toml"), "utf8");
    expect(text).toContain('id = "qwen"');
    expect(body.stations.stations.map((s) => s.station.id)).toEqual([
      "opus",
      "sonnet",
      "qwen",
    ]);
  });

  it("leaves the running daemon agreeing with the file it just wrote", async () => {
    const { url } = await boot();
    await post(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });

    // No reload call from the test: the route must have done it, or the tile
    // appears and the next run cannot resolve the Station.
    const { body } = await get<StationsResponse>(url, "/stations");
    expect(body.stations.map((s) => s.station.id)).toContain("qwen");
  });

  it("seeds the leash with .git/** so an allow of ** cannot reach hooks", async () => {
    const { url } = await boot();
    const { body } = await post<Added>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    expect(body.station.paths).toEqual(["**"]);
    expect(body.station.deny).toContain(".git/**");
  });

  it("preserves the tables the test config carries, gates included", async () => {
    // The writer appends to the file's *text*, so nothing it did not write is
    // at risk — whether or not this build parses it. Both cases are checked:
    // `[gate.default]` is implemented now, `[limits]` is still deferred.
    const { url } = await boot();
    await post(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    const text = await readFile(path.join(cwd, "cuesheet.toml"), "utf8");
    expect(text).toContain("[gate.default]");
    expect(text).toContain('require = "1-of-1"');
    expect(text).toContain("[limits]");
    expect(text).toContain("warn_at = 0.85");
  });

  it("409s a duplicate id instead of silently shadowing a tile", async () => {
    const { url } = await boot();
    const { status } = await post<ApiError>(url, "/stations", {
      id: "opus",
      harness: "claude-code",
      role: "engineer",
      workspace: await workspace(),
    });
    expect(status).toBe(409);
  });

  it("400s a workspace that does not exist", async () => {
    const { url } = await boot();
    const { status, body } = await post<ApiError>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: path.join(tmpdir(), "cuesheet-definitely-not-here"),
    });
    expect(status).toBe(400);
    expect(body.error).toContain("does not exist");
  });

  it("400s a workspace that is a file", async () => {
    const { url } = await boot();
    const file = path.join(cwd, "cuesheet.toml");
    const { status, body } = await post<ApiError>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: file,
    });
    expect(status).toBe(400);
    expect(body.error).toContain("not a directory");
  });

  it("400s an invalid role and writes nothing", async () => {
    const { url } = await boot();
    const before = await readFile(path.join(cwd, "cuesheet.toml"), "utf8");
    const { status } = await post<ApiError>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "pilot",
      workspace: await workspace(),
    });
    expect(status).toBe(400);
    expect(await readFile(path.join(cwd, "cuesheet.toml"), "utf8")).toBe(
      before,
    );
  });

  it("400s an id that would escape the runs directory", async () => {
    const { url } = await boot();
    const { status } = await post<ApiError>(url, "/stations", {
      id: "../escape",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    expect(status).toBe(400);
  });

  it("is reachable under /api too, which is what the Desk calls", async () => {
    const { url } = await boot();
    const { status } = await post<Added>(url, "/api/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    expect(status).toBe(201);
  });
});
