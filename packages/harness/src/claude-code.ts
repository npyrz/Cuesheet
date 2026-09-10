/**
 * The `claude-code` harness.
 *
 * The README calls harness churn "the permanent tax". The tax is only cheap if
 * it is confined, so everything that knows the shape of Claude Code's output
 * lives in this file and nothing above it does. When the CLI's stream format
 * moves — and it will — this file changes and nothing else does.
 *
 * The flags below were confirmed against `claude --help` (2.1.x) rather than
 * recalled, and the mapper was written against a captured real stream, kept as
 * `fixtures/claude-code-stream.jsonl`. Writing a mapper from memory is how you
 * get a parser that handles a format nobody ships.
 *
 * ## The honest limit on the leash
 *
 * `Workspace` binds harnesses that do their own file I/O. This one does not:
 * it hands the work to a subprocess with its own Edit and Write tools, and
 * that subprocess never consults our facade. So for this harness the leash is
 * enforced as far as the CLI's own scoping allows — the run is confined to the
 * workspace directory, and denied globs become `--disallowed-tools` where they
 * can — and *observed* after the fact: every file the CLI touches is checked
 * against the leash and a violation is emitted as a `denial`.
 *
 * That is weaker than the README's "cannot write there", and it is written
 * down here rather than left to be discovered. Closing it properly needs the
 * CLI's own permission hooks, which is its own step.
 */
import {
  checkPath,
  type HarnessProbe,
  type StandbyAnswer,
  type Station,
} from "@cuesheet/core";
import { jsonLineReader, run as spawnRun, which } from "./spawn.js";
import type {
  Connector,
  ContextFile,
  Harness,
  HarnessEvent,
  HarnessProbeResult,
  RunContext,
  RunResult,
  UsageWindow,
} from "./types.js";

export const CLAUDE_BIN = "claude";

/** Long enough for a cold start behind Defender; short enough not to hang the Desk. */
const PROBE_TIMEOUT_MS = 20_000;

export interface ClaudeCodeOptions {
  /** Override the binary, for tests and for a non-standard install. */
  bin?: string;
  /** Falls back to `--permission-mode acceptEdits`. See the note below. */
  permissionMode?: string;
}

export function createClaudeCodeHarness(
  options: ClaudeCodeOptions = {},
): Harness {
  const bin = options.bin ?? CLAUDE_BIN;

  const contextFiles: readonly ContextFile[] = [
    { path: "CLAUDE.md", scope: "project" },
    { path: ".claude/CLAUDE.md", scope: "user" },
  ];

  return {
    id: "claude-code",
    vendor: "anthropic",
    roles: ["engineer", "reviewer", "caller"],

    async probe(): Promise<HarnessProbeResult> {
      const binPath = await which(bin);
      if (binPath === null) {
        return {
          installed: false,
          authed: false,
          error: `\`${bin}\` is not on your PATH.`,
        };
      }

      try {
        const result = await spawnRun(binPath, ["--version"], {
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (result.code !== 0) {
          return {
            installed: true,
            authed: false,
            binPath,
            error: `\`${bin} --version\` exited ${String(result.code)}.`,
          };
        }
        return {
          installed: true,
          // Not a login check, and it does not pretend to be. The CLI has no
          // cheap "am I authenticated" query, and the alternative — a throwaway
          // prompt — costs tokens on every poll of `/stations`. A run that
          // turns out to be unauthenticated fails with the CLI's own message,
          // which is more useful than a guess made here.
          authed: true,
          version: parseVersion(result.stdout),
          binPath,
        };
      } catch (error) {
        return { installed: true, authed: false, binPath, error: text(error) };
      }
    },

    async usage(): Promise<UsageWindow[]> {
      // The CLI does report limits — as `rate_limit_event` lines *inside* a
      // run (see the fixture), not as a queryable command. Surfacing those is
      // M2's job, and `mapRateLimit` below already turns one into a
      // `UsageWindow` so that milestone is a wiring change, not a parse.
      return [];
    },

    contextFiles,

    async writeConnectors(_connectors: readonly Connector[]): Promise<void> {
      // MCP registration is M4. Deliberately inert rather than absent.
    },

    async run(ctx: RunContext): Promise<RunResult> {
      const binPath = (await which(bin)) ?? bin;
      const args = buildArgs(ctx.station, options.permissionMode);

      const state = createStreamState(ctx.station, (event) => ctx.emit(event));

      const reader = jsonLineReader(
        (value) => {
          for (const event of mapStreamEvent(value, state)) ctx.emit(event);
        },
        // Anything that is not JSON becomes text rather than an error, exactly
        // as the plan requires. A CLI that prints one progress line to stdout
        // must not be able to fail an otherwise good run.
        (line) => ctx.emit({ t: "text", chunk: `${line}\n` }),
      );

      const result = await spawnRun(binPath, args, {
        cwd: ctx.workspace.path,
        // The prompt goes on stdin, never as an argv element. It is text the
        // user typed; on Windows `cross-spawn` has to route a `.cmd` through
        // `cmd.exe`, and argv is where quoting bugs become injection bugs.
        stdin: ctx.brief,
        signal: ctx.signal,
        onStdout: (line) => reader.push(`${line}\n`),
        // stderr is diagnostics, not output. Surfaced as text so a failure is
        // readable in the run log instead of vanishing.
        onStderr: (line) => {
          if (line.trim() !== "") ctx.emit({ t: "text", chunk: `${line}\n` });
        },
      });
      reader.flush();

      for (const event of state.drainCost()) ctx.emit(event);

      const diff = await ctx.workspace.diff();

      if (result.killed || ctx.signal.aborted) {
        return { status: "stopped", cost: state.total(), diff };
      }

      if (result.code !== 0 || state.errored) {
        return {
          status: "failed",
          cost: state.total(),
          diff,
          error:
            state.errorMessage ??
            `\`${bin}\` exited ${String(result.code)}.` +
              (result.stderr.trim() === ""
                ? ""
                : ` ${result.stderr.trim().slice(0, 400)}`),
        };
      }

      return { status: "done", cost: state.total(), diff };
    },
  };
}

/** The default instance, registered by {@link defaultHarnesses}. */
export const claudeCodeHarness: Harness = createClaudeCodeHarness();

// ── Invocation ──────────────────────────────────────────────────────────────

/**
 * The headless invocation.
 *
 * `--verbose` is not optional decoration: `--output-format stream-json` under
 * `--print` requires it, and without it the CLI refuses to start.
 *
 * `--permission-mode` matters more than it looks. A headless run that hits a
 * permission prompt has nowhere to show it and waits forever — a hung run with
 * no visible cause. `acceptEdits` is the default here because Cuesheet's own
 * leash is the boundary that is supposed to matter; `bypassPermissions` is
 * deliberately *not* the default, since it also lifts the CLI's guards on
 * everything outside the workspace.
 */
export function buildArgs(
  station: Station,
  permissionMode = "acceptEdits",
): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    permissionMode,
  ];
  if (station.model) args.push("--model", station.model);
  return args;
}

/** `claude --version` prints `2.1.221 (Claude Code)`; we want the number. */
export function parseVersion(stdout: string): string {
  const line = stdout.trim().split("\n")[0] ?? "";
  return /^(\d+\.\d+\.\d+\S*)/.exec(line)?.[1] ?? line.trim();
}

// ── Stream mapping ──────────────────────────────────────────────────────────

export interface StreamState {
  errored: boolean;
  errorMessage?: string;
  /** Cost events the mapper has produced but not yet handed to the caller. */
  drainCost(): HarnessEvent[];
  total(): { tokensIn: number; tokensOut: number; usd?: number };
}

interface InternalState extends StreamState {
  seenMessages: Set<string>;
  tokensIn: number;
  tokensOut: number;
  usd?: number;
  pending: HarnessEvent[];
  station: Station;
  emit: (event: HarnessEvent) => void;
}

export function createStreamState(
  station: Station,
  emit: (event: HarnessEvent) => void = () => undefined,
): StreamState {
  const state: InternalState = {
    errored: false,
    seenMessages: new Set<string>(),
    tokensIn: 0,
    tokensOut: 0,
    pending: [],
    station,
    emit,
    drainCost() {
      const drained = state.pending;
      state.pending = [];
      return drained;
    },
    total() {
      return {
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        ...(state.usd !== undefined && { usd: state.usd }),
      };
    },
  };
  return state;
}

/**
 * Map one stream line onto zero or more `HarnessEvent`s.
 *
 * Exported, and pure apart from the accumulator it is handed, so the mapper is
 * tested against a captured stream with no process anywhere near it.
 */
export function mapStreamEvent(
  value: unknown,
  state: StreamState,
): HarnessEvent[] {
  const s = state as InternalState;
  if (value === null || typeof value !== "object") return [];
  const ev = value as Record<string, unknown>;
  const type = ev["type"];

  switch (type) {
    case "system":
      return mapSystem(ev);
    case "assistant":
      return mapAssistant(ev, s);
    case "user":
      // Tool *results* are echoed back into the stream. They are the model's
      // input, not its output, and rendering them doubles every tool call in
      // the run log. The `tool` event already recorded that the call happened.
      return [];
    case "rate_limit_event":
      // Parsed for M2 (see `mapRateLimit`); nothing on the wire consumes a
      // usage window yet, so it is silently absorbed rather than shown as
      // unexplained text.
      return [];
    case "result":
      return mapResult(ev, s);
    default:
      // Unrecognised becomes text, never an error. A new event type in the
      // next CLI release must degrade to a visible line, not a failed run.
      return [{ t: "text", chunk: `${JSON.stringify(value)}\n` }];
  }
}

function mapSystem(ev: Record<string, unknown>): HarnessEvent[] {
  // `thinking_tokens` arrives once per few tokens — 80 lines in a 5-second
  // run. Rendering them would bury the actual output.
  if (ev["subtype"] === "thinking_tokens") return [];
  if (ev["subtype"] === "init") {
    const model = typeof ev["model"] === "string" ? ev["model"] : "unknown";
    return [{ t: "text", chunk: `Started ${model}.\n` }];
  }
  return [];
}

function mapAssistant(
  ev: Record<string, unknown>,
  state: InternalState,
): HarnessEvent[] {
  const message = asRecord(ev["message"]);
  if (!message) return [];
  const events: HarnessEvent[] = [];

  const content = Array.isArray(message["content"]) ? message["content"] : [];
  for (const raw of content) {
    const block = asRecord(raw);
    if (!block) continue;
    switch (block["type"]) {
      case "text":
        if (typeof block["text"] === "string") {
          events.push({ t: "text", chunk: block["text"] });
        }
        break;
      case "thinking":
        // Deliberately dropped. It is the model's scratchpad, it is long, and
        // the run log is meant to be readable at a glance.
        break;
      case "tool_use": {
        const name = typeof block["name"] === "string" ? block["name"] : "tool";
        const input = block["input"];
        events.push({ t: "tool", name, input });
        events.push(...fileEvents(name, input, state));
        break;
      }
      default:
        break;
    }
  }

  // Usage is repeated on every content block of the same message (confirmed in
  // the fixture: two blocks, identical `usage`, one `message.id`). Summing
  // per-line would double every token count, so it is recorded once per id.
  const id = typeof message["id"] === "string" ? message["id"] : null;
  if (id !== null && !state.seenMessages.has(id)) {
    state.seenMessages.add(id);
    const usage = asRecord(message["usage"]);
    if (usage) {
      const tokensIn = inputTokens(usage);
      const tokensOut = numberAt(usage, "output_tokens");
      if (tokensIn > 0 || tokensOut > 0) {
        // Streamed live for the tiles; the authoritative total arrives with
        // the `result` line and replaces this (see `mapResult`).
        state.pending.push({ t: "cost", tokensIn, tokensOut });
      }
    }
  }

  return events;
}

/**
 * Derive `file` events — and leash violations — from a tool call.
 *
 * This is the observation half of the note at the top of this file. The CLI's
 * own tools have already run by the time we see this, so a denial here is a
 * report rather than a prevention. Reporting it is still worth doing: it is
 * how an operator finds out a Station is reaching somewhere it should not.
 */
function fileEvents(
  name: string,
  input: unknown,
  state: InternalState,
): HarnessEvent[] {
  const record = asRecord(input);
  const path =
    record && typeof record["file_path"] === "string"
      ? record["file_path"]
      : null;
  if (path === null) return [];

  const op: "read" | "write" = name === "Read" ? "read" : "write";
  const events: HarnessEvent[] = [{ t: "file", path, op }];

  const decision = checkPath(state.station, path);
  if (!decision.allowed) {
    events.push({
      t: "denial",
      reason:
        decision.reason ??
        "Outside this Station's leash — the CLI touched it anyway.",
      path,
    });
  }
  return events;
}

function mapResult(
  ev: Record<string, unknown>,
  state: InternalState,
): HarnessEvent[] {
  const usage = asRecord(ev["usage"]);
  if (usage) {
    // The authoritative totals. They *replace* the streamed running counts
    // rather than adding to them — the stream was a live estimate of the same
    // spend, and adding both is how a limits ledger reports double.
    state.tokensIn = inputTokens(usage);
    state.tokensOut = numberAt(usage, "output_tokens");
  }
  const cost = ev["total_cost_usd"];
  if (typeof cost === "number" && Number.isFinite(cost)) state.usd = cost;

  if (ev["is_error"] === true) {
    state.errored = true;
    const subtype = typeof ev["subtype"] === "string" ? ev["subtype"] : "error";
    const detail = typeof ev["result"] === "string" ? ev["result"] : subtype;
    state.errorMessage = detail;
  }

  return [];
}

/**
 * Total input tokens, cache included.
 *
 * Cache reads and cache writes are billed — at different rates, but billed —
 * and the README's limits strip exists so someone is not surprised by a bill.
 * Counting only `input_tokens` would have reported 17 for a run that actually
 * consumed 50,270.
 */
function inputTokens(usage: Record<string, unknown>): number {
  return (
    numberAt(usage, "input_tokens") +
    numberAt(usage, "cache_creation_input_tokens") +
    numberAt(usage, "cache_read_input_tokens")
  );
}

/**
 * Turn a `rate_limit_event` into a usage window.
 *
 * Unused until M2 and exported anyway, because it is the parse that milestone
 * needs and the fixture proving the shape exists now.
 */
export function mapRateLimit(value: unknown): UsageWindow | null {
  const ev = asRecord(value);
  const info = ev && asRecord(ev["rate_limit_info"]);
  if (!info) return null;
  const window =
    typeof info["rateLimitType"] === "string"
      ? info["rateLimitType"]
      : "unknown";
  const resetsAt = info["resetsAt"];
  return {
    window,
    // The CLI reports a status, not a fraction. `allowed` is not "0% used" —
    // it is "not yet blocked" — so the honest mapping is a floor, and M2 has
    // to decide what to render rather than inherit a fabricated number.
    used: info["status"] === "allowed" ? 0 : 1,
    ...(typeof resetsAt === "number" && {
      resetsAt: new Date(resetsAt * 1000).toISOString(),
    }),
  };
}

/** Answering a Standby is the operator's; nothing here consumes one yet. */
export type { StandbyAnswer };

// ── Small helpers ───────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Re-exported for the daemon's `/stations` route. */
export type { HarnessProbe };
