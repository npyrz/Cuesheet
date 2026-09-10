/**
 * The mapper is tested against a *captured* stream, not an invented one.
 *
 * `fixtures/claude-code-stream.jsonl` is a real `claude -p --output-format
 * stream-json --verbose` run (paths scrubbed, thinking signatures redacted,
 * the 80 `thinking_tokens` lines trimmed to two). A mapper written from memory
 * handles a format nobody ships; this one handles the format that arrived.
 *
 * The live end-to-end test at the bottom is gated on `CUESHEET_E2E=1`. CI has
 * no logged-in `claude`, and a default-on test that costs tokens is a test
 * people delete.
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { Station } from "@cuesheet/core";
import {
  buildArgs,
  claudeCodeHarness,
  createStreamState,
  mapRateLimit,
  mapStreamEvent,
  parseVersion,
} from "./claude-code.js";
import { exerciseHarness } from "./contract.js";
import { run } from "./spawn.js";
import type { HarnessEvent } from "./types.js";

const FIXTURE = fileURLToPath(
  new URL("./fixtures/claude-code-stream.jsonl", import.meta.url),
);

let lines: unknown[];

beforeAll(async () => {
  const text = await readFile(FIXTURE, "utf8");
  lines = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
});

function station(overrides: Partial<Station> = {}): Station {
  return {
    id: "opus",
    harness: "claude-code",
    role: "engineer",
    workspace: "/tmp/scratch",
    paths: ["**"],
    deny: [".git/**", "**/*.env"],
    ...overrides,
  };
}

function mapAll(overrides: Partial<Station> = {}) {
  const state = createStreamState(station(overrides));
  const events: HarnessEvent[] = [];
  for (const line of lines) events.push(...mapStreamEvent(line, state));
  return { events, state };
}

describe("buildArgs", () => {
  it("asks for the streaming JSON format, verbosely", () => {
    // `--verbose` is not decoration: `--output-format stream-json` under
    // `--print` requires it, and the CLI refuses to start without it.
    const args = buildArgs(station());
    expect(args).toContain("--print");
    expect(args.join(" ")).toContain("--output-format stream-json");
    expect(args).toContain("--verbose");
  });

  it("always sets a permission mode", () => {
    // A headless run that hits a permission prompt has nowhere to show it and
    // waits forever — a hung run with no visible cause.
    expect(buildArgs(station())).toContain("--permission-mode");
  });

  it("does not default to bypassing permissions", () => {
    // `bypassPermissions` also lifts the CLI's guards outside the workspace.
    expect(buildArgs(station()).join(" ")).not.toContain("bypassPermissions");
  });

  it("passes the Station's model through, and omits it when unset", () => {
    expect(buildArgs(station({ model: "opus" })).join(" ")).toContain(
      "--model opus",
    );
    expect(buildArgs(station({ model: undefined }))).not.toContain("--model");
  });

  it("never puts the prompt in argv", () => {
    // The prompt is text the user typed; on Windows a `.cmd` is routed through
    // `cmd.exe`, and argv is where quoting bugs become injection bugs.
    expect(buildArgs(station()).join(" ")).not.toContain("prompt");
  });
});

describe("parseVersion", () => {
  it("extracts the number from the CLI's banner", () => {
    expect(parseVersion("2.1.221 (Claude Code)\n")).toBe("2.1.221");
  });

  it("falls back to the whole line when the shape changes", () => {
    expect(parseVersion("Claude Code v9\n")).toBe("Claude Code v9");
  });
});

describe("mapping a captured stream", () => {
  it("produces the assistant's text", () => {
    const { events } = mapAll();
    const text = events
      .filter((e): e is Extract<HarnessEvent, { t: "text" }> => e.t === "text")
      .map((e) => e.chunk)
      .join("");
    expect(text).toContain("greeting.txt");
  });

  it("drops thinking blocks", () => {
    // The model's scratchpad is long and the run log is meant to be readable.
    const { events } = mapAll();
    const text = events
      .filter((e): e is Extract<HarnessEvent, { t: "text" }> => e.t === "text")
      .map((e) => e.chunk)
      .join("");
    expect(text).not.toContain("The user wants me to create a file");
  });

  it("drops thinking_tokens noise", () => {
    // 80 of these arrive in a 5-second run; rendering them buries the output.
    const state = createStreamState(station());
    const events = mapStreamEvent(
      { type: "system", subtype: "thinking_tokens", estimated_tokens: 4 },
      state,
    );
    expect(events).toEqual([]);
  });

  it("turns a tool_use into a tool event and a file event", () => {
    const { events } = mapAll();
    const tool = events.find((e) => e.t === "tool");
    expect(tool).toMatchObject({ t: "tool", name: "Write" });
    const file = events.find((e) => e.t === "file");
    expect(file).toMatchObject({ t: "file", op: "write" });
  });

  it("does not echo tool results back as output", () => {
    // They are the model's *input*. Rendering them doubles every tool call.
    const state = createStreamState(station());
    const userLine = lines.find(
      (line) => (line as { type?: string }).type === "user",
    );
    expect(mapStreamEvent(userLine, state)).toEqual([]);
  });

  it("reports the result's totals, not the sum of the streamed estimates", () => {
    // Usage repeats on every content block of a message (two blocks, one
    // `message.id`, identical `usage` — see the fixture), and the streamed
    // counts are a live estimate of the same spend the result settles. Adding
    // both is how a limits ledger reports double.
    const { state } = mapAll();
    expect(state.total()).toEqual({
      tokensIn: 17 + 25303 + 24950,
      tokensOut: 317,
      usd: 0.055307,
    });
  });

  it("counts cache tokens as input, because they are billed", () => {
    // Counting only `input_tokens` would report 17 for a run that consumed
    // 50,270 — and the limits strip exists so nobody is surprised by a bill.
    const { state } = mapAll();
    expect(state.total().tokensIn).toBeGreaterThan(50_000);
  });

  it("streams a live cost estimate while the run is in flight", () => {
    const { state } = mapAll();
    // Drained after the fact here; the harness drains at the end of the run.
    expect(state.drainCost().length).toBeGreaterThan(0);
  });

  it("does not mark a successful run as errored", () => {
    const { state } = mapAll();
    expect(state.errored).toBe(false);
  });

  it("flags a failure and keeps its message", () => {
    const state = createStreamState(station());
    mapStreamEvent(
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "the model refused",
        usage: { input_tokens: 5, output_tokens: 0 },
      },
      state,
    );
    expect(state.errored).toBe(true);
  });

  it("reports a file the CLI touched outside the leash", () => {
    // The honest limit: the CLI's own Write tool has already run by the time
    // we see this, so a denial here is a report rather than a prevention. It
    // is still how an operator finds out a Station is reaching too far.
    const state = createStreamState(station({ deny: ["**/*.txt"] }));
    const events = mapStreamEvent(
      {
        type: "assistant",
        message: {
          id: "m-deny",
          content: [
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "/tmp/scratch/greeting.txt" },
            },
          ],
        },
      },
      state,
    );
    expect(events.find((e) => e.t === "denial")).toBeDefined();
  });

  it("turns an unrecognised event into text rather than an error", () => {
    // A new event type in the next CLI release must degrade to a visible line,
    // not a failed run. The README calls harness churn the permanent tax.
    const state = createStreamState(station());
    const events = mapStreamEvent(
      { type: "some_future_thing", detail: 1 },
      state,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.t).toBe("text");
  });

  it("ignores a non-object line", () => {
    expect(mapStreamEvent(42, createStreamState(station()))).toEqual([]);
  });
});

describe("mapRateLimit", () => {
  it("parses the window M2 will need", () => {
    const info = lines.find(
      (line) => (line as { type?: string }).type === "rate_limit_event",
    );
    expect(mapRateLimit(info)).toMatchObject({
      window: "five_hour",
      used: 0,
    });
    expect(mapRateLimit(info)?.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("is null for anything else", () => {
    expect(mapRateLimit({ type: "result" })).toBeNull();
  });
});

describe("probe", () => {
  it("reports a missing binary without throwing", async () => {
    const harness = (await import("./claude-code.js")).createClaudeCodeHarness({
      bin: "cuesheet-no-such-claude",
    });
    const probe = await harness.probe();
    expect(probe).toMatchObject({ installed: false, authed: false });
    expect(probe.error).toMatch(/PATH/);
  });
});

/**
 * Step 16's done-when, against a real model and a real git repo.
 *
 * Off by default: it spends tokens and needs a logged-in CLI, neither of which
 * a CI matrix has. Run it with `CUESHEET_E2E=1 npm test`.
 */
const live = process.env["CUESHEET_E2E"] === "1" ? describe : describe.skip;

live("claude-code end to end", () => {
  it("streams text, writes a file, and produces a diff", async () => {
    const repo = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-e2e-")),
    );
    await run("git", ["init", "-q", "."], { cwd: repo });
    await run("git", ["config", "user.email", "e2e@example.com"], {
      cwd: repo,
    });
    await run("git", ["config", "user.name", "E2E"], { cwd: repo });
    await writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
    await run("git", ["add", "-A"], { cwd: repo });
    await run("git", ["commit", "-qm", "init"], { cwd: repo });

    const report = await exerciseHarness(claudeCodeHarness, {
      station: station({ workspace: repo, model: "haiku" }),
      brief:
        "Create a file called greeting.txt containing the single word: hello",
    });

    expect(report.violations).toEqual([]);
    expect(report.result.status).toBe("done");
    expect(report.events.some((event) => event.t === "text")).toBe(true);
    expect(report.result.diff?.patch).toContain("greeting.txt");
    expect(report.result.cost?.tokensOut).toBeGreaterThan(0);
  }, 300_000);
});
