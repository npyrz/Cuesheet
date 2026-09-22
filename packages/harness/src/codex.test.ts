/**
 * The `codex` mapper, tested against *captured* streams.
 *
 * Three fixtures, each a real `codex exec --json` run with the scratch paths
 * scrubbed:
 *
 * - `codex-stream.jsonl` — an engineer run that read files, applied a patch,
 *   and ran a verification command. The shape most runs have.
 * - `codex-review.jsonl` — a `read-only` run given Cuesheet's own
 *   `REVIEW_INSTRUCTIONS`, which answered with the fenced JSON verdict the
 *   daemon's parser reads. This is the fixture that proves the second vendor
 *   can actually satisfy a Gate.
 * - `codex-error.jsonl` — a run against a model the account cannot use. It
 *   carries both kinds of error the stream has, which turn out to mean very
 *   different things.
 *
 * The live end-to-end test at the bottom is gated on `CUESHEET_E2E=1`, like
 * the `claude-code` one: CI has no logged-in `codex`, and a default-on test
 * that costs money is a test people delete.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { parseVerdict, type Station } from "@cuesheet/core";
import {
  buildArgs,
  codexHarness,
  codexConnectorArgs,
  createCodexState,
  isTransportNoise,
  mapCodexEvent,
  parseVersion,
  sandboxFor,
  unwrap,
} from "./codex.js";
import { harnessContractViolations, exerciseHarness } from "./contract.js";
import { observedStation } from "./observe.js";
import type { HarnessEvent } from "./types.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

async function load(name: string): Promise<unknown[]> {
  const text = await readFile(fixture(name), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

let engineer: unknown[];
let review: unknown[];
let errored: unknown[];

beforeAll(async () => {
  [engineer, review, errored] = await Promise.all([
    load("codex-stream.jsonl"),
    load("codex-review.jsonl"),
    load("codex-error.jsonl"),
  ]);
});

function station(overrides: Partial<Station> = {}): Station {
  return {
    id: "gpt",
    harness: "codex",
    role: "engineer",
    workspace: "/tmp/scratch",
    paths: ["**"],
    deny: [".git/**", "**/*.env"],
    ...overrides,
  };
}

function mapAll(lines: unknown[], overrides: Partial<Station> = {}) {
  const state = createCodexState(station(overrides));
  const events: HarnessEvent[] = [];
  for (const line of lines) events.push(...mapCodexEvent(line, state));
  events.push(...state.drainCost());
  return { events, state };
}

// ── The contract ────────────────────────────────────────────────────────────

describe("the harness itself", () => {
  it("satisfies the structural contract", () => {
    expect(harnessContractViolations(codexHarness)).toEqual([]);
  });

  it("declares a vendor distinct from claude-code, which is the whole point", () => {
    // If this ever equals "anthropic", `distinct_vendors = 2` silently stops
    // meaning anything and every Gate in every config quietly weakens.
    expect(codexHarness.vendor).toBe("openai");
    expect(codexHarness.id).toBe("codex");
  });

  it("can play the reviewer seat", () => {
    expect(codexHarness.roles).toContain("reviewer");
  });

  it("projects into AGENTS.md, which is where Codex looks", () => {
    expect(codexHarness.contextFiles.map((f) => f.path)).toContain("AGENTS.md");
  });

  it("reports no usage window rather than inventing one", async () => {
    // Codex's stream carries token counts but nothing about plan windows. A
    // fabricated 0% on the limits strip is worse than an absent row.
    expect(await codexHarness.usage()).toEqual([]);
  });
});

// ── Invocation ──────────────────────────────────────────────────────────────

describe("buildArgs", () => {
  it("runs headless, as JSONL, reading the prompt from stdin", () => {
    const args = buildArgs(station());
    expect(args).toContain("exec");
    expect(args).toContain("--json");
    // Without `exec` Codex opens its TUI and waits forever for a keystroke.
    expect(args[0]).toBe("exec");
    // The trailing `-` is what sends it to stdin instead of argv.
    expect(args.at(-1)).toBe("-");
  });

  it("tolerates a workspace that is not a git repository", () => {
    // A Station may legitimately point at a plain directory; `diff()` already
    // copes, so the harness must not be the thing that refuses.
    expect(buildArgs(station())).toContain("--skip-git-repo-check");
  });

  it("passes the model only when the Station names one", () => {
    expect(buildArgs(station())).not.toContain("--model");
    expect(buildArgs(station({ model: "gpt-5" }))).toContain("gpt-5");
  });

  it("cannot put the prompt in argv, because it is never given one", () => {
    // The injection guard, enforced by the signature rather than by care:
    // `buildArgs` takes a Station and no brief, so there is no argument for a
    // user's prose to arrive through. It reaches the process on stdin — which
    // matters most on Windows, where `cross-spawn` routes a `.cmd` through
    // `cmd.exe` and argv is where quoting bugs become injection bugs.
    expect(buildArgs).toHaveLength(2);
    const args = buildArgs(station());
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain("--prompt");
  });
});

describe("Commons connector registration", () => {
  it("uses Codex's URL form rather than editing config.toml itself", () => {
    expect(
      codexConnectorArgs({
        name: "cuesheet-commons",
        url: "http://127.0.0.1:7373/mcp",
      }),
    ).toEqual([
      "mcp",
      "add",
      "cuesheet-commons",
      "--url",
      "http://127.0.0.1:7373/mcp",
    ]);
  });
});

describe("sandboxFor", () => {
  it("gives a reviewer a read-only sandbox", () => {
    // The README promises a reviewer "cannot write to the workspace". This is
    // the line that makes that true of the subprocess rather than of a prompt.
    expect(sandboxFor(station({ role: "reviewer" }))).toBe("read-only");
    expect(buildArgs(station({ role: "reviewer" }))).toContain("read-only");
  });

  it("gives a caller a read-only sandbox too", () => {
    // A Caller emits a plan and may not act on it — including by editing.
    expect(sandboxFor(station({ role: "caller" }))).toBe("read-only");
  });

  it("gives a worker a read-only sandbox, which is the seat's strongest form", () => {
    // Worth stating why this line matters more than the other two: the
    // documented hole in this harness is that a write inside a shell command
    // emits no `file_change` and so cannot be *observed*. The sandbox has no
    // such hole — Codex refuses the write itself — so a worker on `codex` is
    // the one place the seat is enforced rather than reported.
    expect(sandboxFor(station({ role: "worker" }))).toBe("read-only");
    expect(buildArgs(station({ role: "worker" }))).toContain("read-only");
  });

  it("gives an engineer write access, scoped to the workspace", () => {
    expect(sandboxFor(station())).toBe("workspace-write");
  });

  it("never reaches for full access", () => {
    for (const role of ["engineer", "reviewer", "worker", "caller"] as const) {
      expect(sandboxFor(station({ role }))).not.toBe("danger-full-access");
    }
  });
});

describe("parseVersion", () => {
  it("pulls the number out of `codex-cli 0.154.0`", () => {
    expect(parseVersion("codex-cli 0.154.0\n")).toBe("0.154.0");
  });

  it("falls back to the whole line it cannot parse", () => {
    expect(parseVersion("something else")).toBe("something else");
  });
});

// ── Mapping an engineer run ─────────────────────────────────────────────────

describe("mapping the captured engineer run", () => {
  it("reports the file the patch touched", () => {
    const { events } = mapAll(engineer);
    const files = events.filter((e) => e.t === "file");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "/tmp/scratch/math.js",
      op: "write",
    });
  });

  it("does not render the same item twice", () => {
    // Codex emits `item.started` and `item.completed` with identical payloads.
    // Without de-duplication every command and patch appears twice.
    const { events } = mapAll(engineer);
    const commands = events.filter((e) => e.t === "tool");
    const unique = new Set(
      commands.map((e) => JSON.stringify((e as { input: unknown }).input)),
    );
    expect(commands).toHaveLength(unique.size);
  });

  it("surfaces shell commands as tool calls", () => {
    const { events } = mapAll(engineer);
    const tools = events.filter((e) => e.t === "tool");
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((e) => (e as { name: string }).name === "shell")).toBe(
      true,
    );
  });

  it("emits every agent message, not only the last", () => {
    // The captured run says something before it works and something after. A
    // reviewer's verdict is usually last but is not guaranteed to be, and the
    // daemon parses accumulated text — dropping any of it can turn a decided
    // review into an abstention.
    const { events } = mapAll(engineer);
    const text = events.filter((e) => e.t === "text");
    expect(text.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the model's reasoning out of the run log", () => {
    const { events } = mapAll(engineer);
    const joined = events
      .filter((e) => e.t === "text")
      .map((e) => (e as { chunk: string }).chunk)
      .join("");
    expect(joined).not.toContain('"type":"reasoning"');
  });

  it("finishes clean", () => {
    const { state } = mapAll(engineer);
    expect(state.errored).toBe(false);
  });
});

describe("token accounting", () => {
  it("does not double-count cached input or reasoning output", () => {
    // Codex's `input_tokens` already includes `cached_input_tokens`, and
    // `output_tokens` already includes `reasoning_output_tokens` — the
    // opposite of Claude Code's convention, which is why this test exists.
    // The captured turn reports 88658/82560 in and 721/23 out; summing the
    // pairs would bill 171218 and 744.
    const { state } = mapAll(engineer);
    expect(state.total()).toEqual({
      tokensIn: 88658,
      tokensOut: 721,
      // Reported as the *breakdown* it is, never added to the total. Step 39
      // made the ledger able to say how much of an input was cache; this is
      // the assertion that the saying does not change the billing.
      cacheRead: 82560,
    });
  });

  it("omits `cacheWrite` rather than claiming a zero", () => {
    // The stream reports `cached_input_tokens` and says nothing about cache
    // *creation*. Absent means "nobody told us"; a zero would claim this
    // runtime never writes a cache, which no capture supports.
    const { state } = mapAll(engineer);
    expect(state.total()).not.toHaveProperty("cacheWrite");
  });

  it("reports no dollar figure, because the stream carries none", () => {
    // An invented price from a table that goes stale is worse than a blank.
    const { state } = mapAll(engineer);
    expect(state.total().usd).toBeUndefined();
  });

  it("emits the total as a cost event for the tiles", () => {
    const { events } = mapAll(engineer);
    expect(events.filter((e) => e.t === "cost")).toHaveLength(1);
  });
});

describe("leash observation", () => {
  it("reports a patch outside the leash as a denial", () => {
    const { events } = mapAll(engineer, { deny: ["**/math.js"] });
    const denials = events.filter((e) => e.t === "denial");
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ path: "/tmp/scratch/math.js" });
  });

  it("stays quiet when the patch is inside it", () => {
    const { events } = mapAll(engineer);
    expect(events.filter((e) => e.t === "denial")).toEqual([]);
  });

  it("treats a delete as a write", () => {
    // A leash that let a Station delete a file it may not modify would have a
    // hole exactly the size of `rm`.
    const state = createCodexState(station({ deny: ["**/secret.txt"] }));
    const events = mapCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "x",
          type: "file_change",
          changes: [{ path: "/tmp/scratch/secret.txt", kind: "delete" }],
          status: "completed",
        },
      },
      state,
    );
    expect(events.filter((e) => e.t === "file")[0]).toMatchObject({
      op: "write",
    });
    expect(events.filter((e) => e.t === "denial")).toHaveLength(1);
  });

  it("does not report a patch inside a symlinked workspace as an escape", async () => {
    // `observedStation` moved out of `claude-code.ts` when this harness needed
    // it, and a shared helper with only one caller under test is a helper half
    // tested. This exercises it through the *codex* path, end to end: resolve
    // the workspace, then map a real `file_change` against it.
    //
    // The case is not hypothetical — it is how the captures for this file were
    // produced. On macOS `/tmp` is a symlink into `/private`, so a workspace
    // at `/tmp/ws` sees every one of its own patches arrive as
    // `/private/tmp/ws/...`. Without the resolve, each reads as an escape and
    // the run log fills with denials for files plainly inside the leash.
    const real = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-codex-real-")),
    );
    const link = path.join(
      await mkdtemp(path.join(tmpdir(), "cuesheet-codex-link-")),
      "ws",
    );
    // A junction rather than a symlink on Windows: a `dir` symlink needs
    // Developer Mode or elevation and throws EPERM without either, and
    // `realpath` resolves both the same way. The assertion keeps its meaning
    // instead of skipping, which is what the repo's own checklist asks for.
    await symlink(
      real,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    const configured = station({ workspace: link });
    const patched = path.join(real, "math.js");
    const change = {
      type: "item.completed",
      item: {
        id: "s",
        type: "file_change",
        changes: [{ path: patched, kind: "update" }],
        status: "completed",
      },
    };

    // Before: the bug, asserted so it cannot come back quietly.
    const naive = createCodexState(configured);
    expect(
      mapCodexEvent(change, naive).filter((e) => e.t === "denial"),
    ).toHaveLength(1);

    // After: what `run()` actually does.
    const observed = createCodexState(await observedStation(configured, link));
    const events = mapCodexEvent(change, observed);
    expect(events.filter((e) => e.t === "file")).toHaveLength(1);
    expect(events.filter((e) => e.t === "denial")).toEqual([]);
  });
});

// ── Mapping a review ────────────────────────────────────────────────────────

describe("mapping the captured review", () => {
  it("passes a verdict the daemon's parser can read", () => {
    // The one test that decides whether this harness can hold up a Gate. The
    // fixture is a real `read-only` Codex run given Cuesheet's own
    // REVIEW_INSTRUCTIONS; the text it produced has to survive mapping intact
    // enough for `parseVerdict` to find the decision in it.
    const { events } = mapAll(review, { role: "reviewer" });
    const text = events
      .filter((e) => e.t === "text")
      .map((e) => (e as { chunk: string }).chunk)
      .join("");

    const parsed = parseVerdict(text);
    expect(parsed.decision).toBe("fail");
    expect(parsed.source).toBe("json");
    expect(parsed.findings.length).toBeGreaterThan(0);
    expect(parsed.findings.some((f) => f.category === "security")).toBe(true);
    expect(parsed.findings.some((f) => f.severity === "block")).toBe(true);
  });

  it("abstains rather than approving when the reply has no verdict in it", () => {
    // The single test that decides whether Gates are a safety feature or a
    // decoration. A reviewer that crashed, rambled, or only said "LGTM" has
    // approved nothing — and an abstention cannot satisfy `require`. The
    // engineer fixture stands in for that reply: real Codex output with no
    // verdict block anywhere in it.
    const { events } = mapAll(engineer, { role: "reviewer" });
    const text = events
      .filter((e) => e.t === "text")
      .map((e) => (e as { chunk: string }).chunk)
      .join("");

    expect(text.trim()).not.toBe("");
    expect(parseVerdict(text).decision).toBe("abstain");
  });

  it("abstains on a stream that died mid-review", () => {
    // A reviewer whose process fell over emits nothing to parse. It must not
    // read as approval; a crashed reviewer waves nothing through.
    const { events } = mapAll(errored, { role: "reviewer" });
    const text = events
      .filter((e) => e.t === "text")
      .map((e) => (e as { chunk: string }).chunk)
      .join("");
    expect(parseVerdict(text).decision).toBe("abstain");
  });

  it("writes nothing while reviewing", () => {
    const { events } = mapAll(review, { role: "reviewer" });
    expect(events.filter((e) => e.t === "file")).toEqual([]);
  });
});

// ── Errors ──────────────────────────────────────────────────────────────────

describe("mapping the captured failure", () => {
  it("fails the run on `turn.failed`", () => {
    const { state } = mapAll(errored);
    expect(state.errored).toBe(true);
  });

  it("unwraps the nested API error into a sentence", () => {
    const { state } = mapAll(errored);
    expect(state.errorMessage).toBe(
      "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(state.errorMessage).not.toContain("invalid_request_error");
  });

  it("treats an error *item* as a warning, not a failure", () => {
    // The captured run proves the distinction: a "Model metadata not found"
    // item arrived and the run carried on. Failing on it would kill runs that
    // succeed.
    const state = createCodexState(station());
    const events = mapCodexEvent(
      {
        type: "item.completed",
        item: { id: "item_0", type: "error", message: "heads up" },
      },
      state,
    );
    expect(state.errored).toBe(false);
    expect(events).toEqual([{ t: "text", chunk: "heads up\n" }]);
  });

  it("shows an unrecognised event instead of failing on it", () => {
    // A new event type in the next Codex release must degrade to a visible
    // line. This is the difference between a harness that ages and one that
    // breaks on a Tuesday.
    const state = createCodexState(station());
    const events = mapCodexEvent({ type: "turn.hypothetical", a: 1 }, state);
    expect(state.errored).toBe(false);
    expect(events[0]).toMatchObject({ t: "text" });
  });

  it("ignores a line that is not an object", () => {
    const state = createCodexState(station());
    expect(mapCodexEvent("nonsense", state)).toEqual([]);
    expect(mapCodexEvent(null, state)).toEqual([]);
  });
});

describe("unwrap", () => {
  it("returns a plain message unchanged", () => {
    expect(unwrap("something broke")).toBe("something broke");
  });

  it("returns invalid JSON unchanged rather than something worse", () => {
    expect(unwrap("{not json")).toBe("{not json");
  });

  it("falls back to a top-level message", () => {
    expect(unwrap(JSON.stringify({ message: "top" }))).toBe("top");
  });
});

describe("isTransportNoise", () => {
  it("filters Codex's own MCP transport chatter", () => {
    // Present on every run on a machine with a stale MCP server configured.
    // Left in, every run log looks broken before the model says a word.
    expect(
      isTransportNoise(
        "2026-09-15T15:45:03Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed",
      ),
    ).toBe(true);
  });

  it("does not swallow a real error", () => {
    expect(isTransportNoise("ERROR: your credential expired")).toBe(false);
  });
});

// ── Live ────────────────────────────────────────────────────────────────────

describe.skipIf(process.env["CUESHEET_E2E"] !== "1")(
  "against a real codex",
  () => {
    it("probes as installed and authenticated", async () => {
      const probe = await codexHarness.probe();
      expect(probe.installed).toBe(true);
      expect(probe.authed).toBe(true);
    }, 60_000);

    it("runs, writes a file, and reports a diff", async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "cuesheet-codex-"));
      await writeFile(path.join(dir, "seed.txt"), "seed\n", "utf8");

      const report = await exerciseHarness(codexHarness, {
        station: station({ workspace: dir }),
        brief: "Create a file called hello.txt containing exactly: hello",
      });

      expect(report.violations).toEqual([]);
      expect(report.result.status ?? "done").toBe("done");
      expect(report.meterTotal.tokensIn).toBeGreaterThan(0);
    }, 300_000);
  },
);
