/**
 * The `codex` harness — OpenAI's CLI, and the second vendor a Gate needs.
 *
 * This file exists for one reason above all the others: `distinct_vendors = 2`
 * is an equality check over `vendor`, and until now a stock build shipped
 * exactly one real one. Gates were demonstrable (`mock` reviewing
 * `claude-code`) but not *usable*, because nobody gates production work behind
 * a fake reviewer. With this registered, the README's headline example —
 * `require = "1-of-1"` with `distinct_vendors = 2` — is satisfiable out of the
 * box.
 *
 * Everything that knows the shape of Codex's output lives here and nothing
 * above it does, the same containment `claude-code.ts` keeps.
 *
 * The flags were read out of `codex --help` and `codex exec --help` (0.154.0)
 * rather than recalled, and every mapping below was written against captured
 * real streams kept in `fixtures/codex-*.jsonl`. The plan refused to write
 * this harness for six weeks on exactly that principle: a stream mapper that
 * has never seen a stream is a guess.
 *
 * ## The honest limit on the leash — weaker here than for `claude-code`
 *
 * Both harnesses hand the work to a subprocess with its own file tools, so
 * both can only *observe* the leash rather than enforce it. Codex is the
 * weaker of the two, and the difference is worth stating plainly because it
 * affects what an operator should trust:
 *
 * Codex does most of its work by running shell commands. A `file_change` item
 * announces an `apply_patch`, and those paths are checked — but the very first
 * stream captured for this file wrote a file with `printf %s hello > greet.txt`
 * inside a `command_execution`, and emitted no `file_change` at all. A write
 * that happens inside a shell command is invisible to path observation.
 *
 * Parsing paths back out of arbitrary shell is not attempted. It would produce
 * a check that works on `printf > x` and silently misses `tee`, `sed -i`, a
 * heredoc, or `python -c`, and a leash that fails quietly is worse than one
 * that is documented as partial. What holds the line instead is Codex's *own*
 * sandbox: `--sandbox` is set from the Station's role, so a `reviewer` runs
 * `read-only` and cannot write at all, and an `engineer` runs
 * `workspace-write` and cannot escape the workspace. That is enforcement by
 * the CLI rather than by us, which is the same bargain `claude-code.ts`
 * strikes with `--permission-mode`.
 */
import {
  checkPath,
  writeDeniedByRole,
  type HarnessProbe,
  type StandbyAnswer,
  type Station,
} from "@cuesheet/core";
import { observedStation } from "./observe.js";
import { jsonLineReader, run as spawnRun, which } from "./spawn.js";
import type {
  Connector,
  ContextFile,
  Cost,
  Harness,
  HarnessEvent,
  HarnessProbeResult,
  RunContext,
  RunResult,
  UsageWindow,
} from "./types.js";

export const CODEX_BIN = "codex";

/** Long enough for a cold start behind Defender; short enough not to hang the Desk. */
const PROBE_TIMEOUT_MS = 20_000;

export interface CodexOptions {
  /** Override the binary, for tests and for a non-standard install. */
  bin?: string;
  /**
   * Override the sandbox policy. Left unset, it is derived from the Station's
   * role, which is what you want — see {@link sandboxFor}.
   */
  sandbox?: string;
}

export function createCodexHarness(options: CodexOptions = {}): Harness {
  const bin = options.bin ?? CODEX_BIN;

  // Codex reads `AGENTS.md` at the project root and `~/.codex/AGENTS.md` for
  // the user scope. Both were confirmed on disk rather than assumed: the
  // captured stream shows the agent itself walking ancestors looking for
  // `AGENTS.md`. The Commons (M4) projects into these.
  const contextFiles: readonly ContextFile[] = [
    { path: "AGENTS.md", scope: "project" },
    { path: ".codex/AGENTS.md", scope: "user" },
  ];

  return {
    id: "codex",
    vendor: "openai",
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
        // Unlike `claude`, Codex *does* have a cheap auth query — `codex login
        // status` prints "Logged in using ChatGPT" and exits 0, or exits
        // non-zero when there is no credential. It costs no tokens, so the
        // Desk can show a real answer instead of `claude-code.ts`'s optimistic
        // one. A failure here is reported as "not authed", never as "not
        // installed": the binary plainly is.
        const auth = await loginStatus(binPath);
        return {
          installed: true,
          authed: auth.authed,
          version: parseVersion(result.stdout),
          binPath,
          ...(auth.error !== undefined && { error: auth.error }),
        };
      } catch (error) {
        return { installed: true, authed: false, binPath, error: text(error) };
      }
    },

    async usage(): Promise<UsageWindow[]> {
      // Codex reports token counts per turn (`turn.completed.usage`) but says
      // nothing about plan windows — there is no equivalent of Claude Code's
      // `rate_limit_event` in the captured streams. So there is no honest
      // window to report, and M2 will have to get this vendor's limits from
      // somewhere else. `[]` rather than a fabricated 0%.
      return [];
    },

    contextFiles,

    async writeConnectors(_connectors: readonly Connector[]): Promise<void> {
      // Codex keeps MCP servers in `~/.codex/config.toml` under `[mcp_servers]`
      // and has a `codex mcp` subcommand for managing them. Wiring that is M4;
      // inert rather than absent, so the milestone is additive.
    },

    async run(ctx: RunContext): Promise<RunResult> {
      const binPath = (await which(bin)) ?? bin;
      const args = buildArgs(ctx.station, options.sandbox);

      const state = createCodexState(
        // Resolved through `realpath` for the same reason `claude-code.ts`
        // does it: Codex reports absolute, already-resolved paths, and on
        // macOS a workspace under `/tmp` sees every one of its own writes
        // arrive as `/private/tmp/...`. Comparing a resolved path against an
        // unresolved one denies files that are plainly inside the workspace.
        await observedStation(ctx.station, ctx.workspace.path),
      );

      const reader = jsonLineReader(
        (value) => {
          for (const event of mapCodexEvent(value, state)) ctx.emit(event);
        },
        // Not-JSON becomes text, never an error. Codex prints its MCP
        // transport warnings on stderr, but a future release printing one
        // progress line to stdout must not be able to fail a good run.
        (line) => ctx.emit({ t: "text", chunk: `${line}\n` }),
      );

      const result = await spawnRun(binPath, args, {
        cwd: ctx.workspace.path,
        // On stdin, never as an argv element — `codex exec -` reads the prompt
        // from stdin by design. Same reasoning as `claude-code.ts`: this is
        // text a user typed, and on Windows `cross-spawn` routes a `.cmd`
        // through `cmd.exe`, where argv quoting bugs become injection bugs.
        stdin: ctx.brief,
        signal: ctx.signal,
        onStdout: (line) => reader.push(`${line}\n`),
        onStderr: (line) => {
          // Codex logs MCP transport failures to stderr at ERROR level on
          // every run where a configured MCP server is not listening. They are
          // noise from the user's own `~/.codex/config.toml`, not this run's
          // problem, and surfacing them makes every run log look broken.
          if (line.trim() === "" || isTransportNoise(line)) return;
          ctx.emit({ t: "text", chunk: `${line}\n` });
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

/** The default instance, registered by `defaultHarnesses()`. */
export const codexHarness: Harness = createCodexHarness();

// ── Invocation ──────────────────────────────────────────────────────────────

/**
 * The sandbox policy for a Station, from its role.
 *
 * This is the one place Cuesheet's roles reach into Codex's own enforcement,
 * and it is the strongest guarantee this harness offers. The README says a
 * `reviewer` "cannot write to the workspace"; `read-only` is what makes that
 * true of the subprocess rather than of a sentence in its prompt.
 *
 * `danger-full-access` is deliberately unreachable, including through
 * `CodexOptions.sandbox`'s intended use. `claude-code.ts` refused to default
 * to `bypassPermissions` for the same reason — an escape hatch that exists
 * gets used, and this one lifts the guards on everything outside the
 * workspace.
 */
export function sandboxFor(station: Station): string {
  // `worker` joins the read-only seats, and it is the one of the three the
  // CLI can enforce *completely*: the shell-command hole documented at the
  // top of this file is a hole in path observation, not in the sandbox, so a
  // worker's `printf > file` is refused by Codex itself rather than merely
  // noticed by us. That makes this the strongest form the seat takes anywhere.
  return station.role === "reviewer" ||
    station.role === "caller" ||
    station.role === "worker"
    ? "read-only"
    : "workspace-write";
}

/**
 * The headless invocation.
 *
 * `exec` is the non-interactive subcommand; without it Codex launches its TUI
 * and waits for a keystroke that is never coming. `--json` is what turns
 * stdout into the JSONL this file maps.
 *
 * `--skip-git-repo-check` is not optional either: Codex refuses to run outside
 * a git repository, and a Station can legitimately point at a plain directory
 * — `createWorkspace` and `diff()` both tolerate a missing `.git`, so the
 * harness has to as well or it fails runs the rest of the system supports.
 *
 * The trailing `-` makes the prompt come from stdin. Without it Codex would
 * want the prompt as an argument, which is the thing this deliberately avoids.
 */
export function buildArgs(station: Station, sandbox?: string): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    sandbox ?? sandboxFor(station),
  ];
  if (station.model) args.push("--model", station.model);
  args.push("-");
  return args;
}

/** `codex --version` prints `codex-cli 0.154.0`; we want the number. */
export function parseVersion(stdout: string): string {
  const line = stdout.trim().split("\n")[0] ?? "";
  return /(\d+\.\d+\.\d+\S*)/.exec(line)?.[1] ?? line.trim();
}

/**
 * Whether there is a usable credential, via `codex login status`.
 *
 * Never throws: a probe that throws takes down `GET /stations`, and "I could
 * not tell" is reported as not-authed with the reason attached.
 */
async function loginStatus(
  binPath: string,
): Promise<{ authed: boolean; error?: string }> {
  try {
    const result = await spawnRun(binPath, ["login", "status"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (result.code === 0) return { authed: true };
    return {
      authed: false,
      error: `Not logged in — run \`codex login\`.`,
    };
  } catch (error) {
    return { authed: false, error: text(error) };
  }
}

/**
 * Codex's own MCP transport chatter, which is not this run's business.
 *
 * Observed on every captured run on a machine with a stale MCP server in
 * `~/.codex/config.toml`: three `ERROR rmcp::transport::worker` lines before
 * the model says anything. Matching narrowly on the module path rather than on
 * the word "ERROR", so a real error from Codex still reaches the run log.
 */
export function isTransportNoise(line: string): boolean {
  return /\brmcp::transport\b/.test(line);
}

// ── Stream mapping ──────────────────────────────────────────────────────────

export interface CodexState {
  errored: boolean;
  errorMessage?: string;
  /** Cost events the mapper has produced but not yet handed to the caller. */
  drainCost(): HarnessEvent[];
  total(): Cost;
}

interface InternalState extends CodexState {
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  pending: HarnessEvent[];
  station: Station;
  /** `item.started` already reported these; `item.completed` must not repeat. */
  announced: Set<string>;
}

export function createCodexState(station: Station): CodexState {
  const state: InternalState = {
    errored: false,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    pending: [],
    station,
    announced: new Set<string>(),
    drainCost() {
      const drained = state.pending;
      state.pending = [];
      return drained;
    },
    total(): Cost {
      // No `usd`. Codex reports tokens and never a price — see `mapTurn`.
      //
      // `cacheRead` ships and `cacheWrite` does not, and the asymmetry is the
      // stream's rather than ours: `cached_input_tokens` is reported,
      // cache *creation* is not. Omitting the field says "nobody told us",
      // which is the honest answer; sending a zero would claim this runtime
      // never writes a cache, and nothing in three captures supports that.
      return {
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        cacheRead: state.cacheRead,
      };
    },
  };
  return state;
}

/**
 * Map one stream line onto zero or more `HarnessEvent`s.
 *
 * Exported and pure apart from the accumulator it is handed, so the mapper is
 * tested against captured streams with no process anywhere near it.
 */
export function mapCodexEvent(
  value: unknown,
  state: CodexState,
): HarnessEvent[] {
  const s = state as InternalState;
  if (value === null || typeof value !== "object") return [];
  const ev = value as Record<string, unknown>;

  switch (ev["type"]) {
    case "thread.started":
    case "turn.started":
      // Bookkeeping. The run already has an id and a start time of its own.
      return [];
    case "item.started":
    case "item.updated":
    case "item.completed":
      return mapItem(ev, s);
    case "turn.completed":
      return mapTurn(ev, s);
    case "turn.failed":
      return mapTurnFailed(ev, s);
    case "error":
      // A top-level `error` is *reported* but does not by itself fail the run.
      // In the captured failure it arrived alongside `turn.failed` and a
      // non-zero exit, both of which already fail it — so flipping `errored`
      // here would add nothing, while a future non-fatal `error` line would
      // wrongly kill an otherwise good run. The message is kept as the best
      // available detail if nothing better arrives.
      if (typeof ev["message"] === "string") {
        s.errorMessage ??= ev["message"];
        return [{ t: "text", chunk: `${ev["message"]}\n` }];
      }
      return [];
    default:
      // Unrecognised becomes text, never an error. A new event type in the
      // next Codex release must degrade to a visible line, not a failed run.
      return [{ t: "text", chunk: `${JSON.stringify(value)}\n` }];
  }
}

function mapItem(
  ev: Record<string, unknown>,
  state: InternalState,
): HarnessEvent[] {
  const item = asRecord(ev["item"]);
  if (!item) return [];
  const id = typeof item["id"] === "string" ? item["id"] : null;

  switch (item["type"]) {
    case "agent_message": {
      // Every agent message, not only the last. A reviewer's fenced verdict
      // block is usually the final item but is not guaranteed to be — the
      // captured edit run has one message before the work and one after — and
      // the daemon's `parseVerdict` reads the accumulated text. Dropping any
      // of it could drop the verdict and turn a decided review into an
      // abstention.
      const text_ = typeof item["text"] === "string" ? item["text"] : "";
      if (text_ === "" || !once(state, id, "msg")) return [];
      return [
        { t: "text", chunk: text_.endsWith("\n") ? text_ : `${text_}\n` },
      ];
    }

    case "reasoning":
      // Dropped, exactly as `claude-code.ts` drops `thinking` blocks. It is
      // the model's scratchpad, it is long, and the run log is meant to be
      // readable at a glance. The tokens are still counted: `turn.completed`
      // reports them inside `output_tokens`.
      return [];

    case "command_execution": {
      // Announced once, when it starts. The identical `item.completed` that
      // follows would otherwise render every command twice in the run log.
      if (!once(state, id, "cmd")) return [];
      const command =
        typeof item["command"] === "string" ? item["command"] : "(command)";
      return [{ t: "tool", name: "shell", input: { command } }];
    }

    case "file_change":
      return fileChangeEvents(item, state, id);

    case "error": {
      // An error *item* is a warning, and the captured bad-model run proves
      // it: "Model metadata … not found. Defaulting to fallback metadata"
      // arrived as one of these and the run carried on and did the work. Only
      // `turn.failed` is fatal. Treating this as fatal would fail runs that
      // succeed.
      const message =
        typeof item["message"] === "string" ? item["message"] : null;
      return message === null ? [] : [{ t: "text", chunk: `${message}\n` }];
    }

    default:
      return [];
  }
}

/**
 * `file_change` → `file` events, plus any leash violation they reveal.
 *
 * The observation half of the note at the top of this file. The patch has
 * already been applied by the time we see this, so a denial here is a report
 * rather than a prevention — worth reporting anyway, because it is how an
 * operator finds out a Station is reaching somewhere it should not.
 *
 * All three `kind`s — `add`, `update`, `delete` — are writes. A leash that
 * permitted deletion because it was not called "write" would be a leash with a
 * hole in it.
 */
function fileChangeEvents(
  item: Record<string, unknown>,
  state: InternalState,
  id: string | null,
): HarnessEvent[] {
  if (!once(state, id, "file")) return [];
  const changes = Array.isArray(item["changes"]) ? item["changes"] : [];
  const events: HarnessEvent[] = [];

  for (const raw of changes) {
    const change = asRecord(raw);
    const path =
      change && typeof change["path"] === "string" ? change["path"] : null;
    if (path === null) continue;

    events.push({ t: "file", path, op: "write" });

    // Same rule as `claude-code.ts`: leaving the seat is reported before the
    // path is judged. Here it should also be unreachable, because `sandboxFor`
    // runs a worker `read-only` and the CLI refuses the patch before it is
    // ever announced. Kept anyway — this is the half that still works if a
    // future Codex renames the flag.
    const roleDenial = writeDeniedByRole(state.station);
    if (roleDenial !== undefined) {
      events.push({ t: "denial", reason: roleDenial, path });
      continue;
    }

    const decision = checkPath(state.station, path);
    if (!decision.allowed) {
      events.push({
        t: "denial",
        reason:
          decision.reason ??
          "Outside this Station's leash — the CLI patched it anyway.",
        path,
      });
    }
  }
  return events;
}

/**
 * `turn.completed` carries the authoritative token counts.
 *
 * **These fields are inclusive, which is the opposite of Claude Code's.**
 * `claude-code.ts`'s `inputTokens()` *sums* `input_tokens` with the two cache
 * fields because that API reports them side by side. Codex does not:
 * `cached_input_tokens` is a subset of `input_tokens`, and
 * `reasoning_output_tokens` a subset of `output_tokens`. Three captured runs
 * agree — 29952 of 34620, 82560 of 88658, 12928 of 17075 — and the review run
 * settles it arithmetically: 839 output tokens minus 658 reasoning leaves 181,
 * which is the size of the JSON verdict it actually printed. Summing would
 * report roughly double on every run, in a ledger whose whole purpose is that
 * nobody is surprised by a bill.
 *
 * There is no dollar figure anywhere in the stream, so `Cost.usd` stays
 * absent rather than being invented from a price table that would go stale.
 */
function mapTurn(
  ev: Record<string, unknown>,
  state: InternalState,
): HarnessEvent[] {
  const usage = asRecord(ev["usage"]);
  if (!usage) return [];
  state.tokensIn = numberAt(usage, "input_tokens");
  state.tokensOut = numberAt(usage, "output_tokens");
  // Already *inside* `input_tokens` — the inclusive-versus-additive asymmetry
  // this function's header comment is about. Recorded as the breakdown it is,
  // never added to the total.
  state.cacheRead = numberAt(usage, "cached_input_tokens");
  if (state.tokensIn > 0 || state.tokensOut > 0) {
    state.pending.push({
      t: "cost",
      tokensIn: state.tokensIn,
      tokensOut: state.tokensOut,
    });
  }
  return [];
}

/** The one fatal signal in the stream. */
function mapTurnFailed(
  ev: Record<string, unknown>,
  state: InternalState,
): HarnessEvent[] {
  state.errored = true;
  const error = asRecord(ev["error"]);
  const message =
    error && typeof error["message"] === "string" ? error["message"] : null;
  // Codex nests the upstream API's own JSON error inside a string. Unwrapping
  // it turns an unreadable `{"type":"error","status":400,…}` in the run log
  // into the sentence a human needs.
  state.errorMessage = message === null ? "The turn failed." : unwrap(message);
  return [];
}

/**
 * Pull the human-readable sentence out of a nested API error payload.
 *
 * Falls back to the original string whenever it is not JSON or has no
 * message, so a plain error is never replaced by something worse.
 */
export function unwrap(message: string): string {
  try {
    const parsed: unknown = JSON.parse(message);
    const record = asRecord(parsed);
    const inner = record && asRecord(record["error"]);
    const text_ = inner?.["message"];
    if (typeof text_ === "string" && text_.trim() !== "") return text_;
    const top = record?.["message"];
    if (typeof top === "string" && top.trim() !== "") return top;
  } catch {
    // Not JSON. The raw string was already the best available answer.
  }
  return message;
}

/**
 * Whether this is the first time an item id has been reported.
 *
 * Codex emits `item.started` and `item.completed` for the same id with the
 * same payload. Without this, every command and every patch appears twice in
 * the run log.
 */
function once(state: InternalState, id: string | null, kind: string): boolean {
  if (id === null) return true;
  const key = `${kind}:${id}`;
  if (state.announced.has(key)) return false;
  state.announced.add(key);
  return true;
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
