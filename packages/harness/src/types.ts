/**
 * The `Harness` interface — the seam the whole project is built around.
 *
 * The README's thesis is that "a harness is meant to be replaceable", and the
 * cost of replacing one should be a dropdown rather than a migration. That is
 * only true if this file is small and if nothing above it knows which harness
 * it is talking to. So: the daemon depends on these types, the harnesses
 * implement them, and neither imports the other.
 *
 * The shape is the README's "Writing a harness" example, deliberately — that
 * example is the published contract and code that diverges from it makes the
 * docs a lie. Two members are intentionally inert for now:
 *
 * - `usage()` may return `[]`. The limits strip is M2; the method exists so
 *   that milestone is additive rather than an interface change.
 * - `writeConnectors()` may do nothing. Same reasoning for the Commons (M4).
 *
 * Direction of dependency: `@cuesheet/core` owns the vocabulary (`Role`,
 * `RunEvent`, `Station`), this package owns the interface, and the *adapter*
 * that turns a `Harness` into something the queue can run lives in the daemon.
 * Putting the adapter here would mean importing the daemon's `RunExecutor`,
 * and a daemon↔harness cycle is exactly what Step 5 split these packages to
 * avoid.
 */
import type {
  Cost,
  DiffStat,
  HarnessId,
  HarnessProbe,
  Role,
  RunId,
  RunStatus,
  Station,
  StandbyAnswer,
  Vendor,
  Verdict,
} from "@cuesheet/core";

// ── Events a harness may raise ──────────────────────────────────────────────

/**
 * What a harness emits — `RunEvent` minus the bookkeeping.
 *
 * `runId`, `at`, and `stationId` are stamped by the adapter, for two reasons.
 * The boring one is that every harness would otherwise repeat the same three
 * lines. The one that matters is that a harness *cannot* then misattribute an
 * event to another run, which is the sort of bug that is invisible until two
 * runs are on screen at once.
 *
 * `status`, `standby`, and `done` are absent on purpose: they are the queue's
 * to emit. A harness that could emit `done` could lie about a run's outcome
 * while still throwing.
 */
export type HarnessEvent =
  | { t: "text"; chunk: string }
  | { t: "tool"; name: string; input: unknown }
  | { t: "file"; path: string; op: "read" | "write" }
  | { t: "denial"; reason: string; path?: string }
  | { t: "cost"; tokensIn: number; tokensOut: number; usd?: number };

export type HarnessEventType = HarnessEvent["t"];

// ── The leashed workspace ───────────────────────────────────────────────────

/** A unified diff plus the numbers needed to render a run row. */
export interface DiffResult {
  /** Unified diff text. Empty string when the run changed nothing. */
  patch: string;
  stat: DiffStat;
}

/**
 * The workspace facade. **A harness never touches `node:fs` directly.**
 *
 * Every path here goes through `checkPath`/`resolveAndCheck` from core first,
 * so the README's promise — "a Station denied `infra/**` cannot write there
 * even if the model decides it should" — is enforced by the runtime rather
 * than requested in a prompt.
 *
 * The honest limit, written down here rather than discovered later: this
 * facade only binds harnesses that do their own file I/O. A harness that
 * shells out to an agent CLI hands the work to a subprocess with its own file
 * tools, and that subprocess does not consult this object. For those, the
 * leash is enforced as far as the CLI's own scoping flags allow and observed
 * after the fact via `file` events. See `claude-code.ts`, which says so at the
 * point where it matters.
 */
export interface Workspace {
  /** Absolute, `~`-expanded, symlink-resolved. Safe to hand to `spawn`. */
  readonly path: string;
  /** Whether the leash permits touching a path. Never throws. */
  check(path: string): Promise<LeashCheck>;
  /** Rejects with {@link LeashDeniedError} when the leash says no. */
  read(path: string): Promise<string>;
  /** Rejects with {@link LeashDeniedError} when the leash says no. */
  write(path: string, contents: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Workspace-relative posix paths, one level. Leash-checked. */
  list(path?: string): Promise<string[]>;
  /**
   * The diff of everything the run changed, as `git diff` sees it.
   *
   * Resolves to an empty patch outside a git repository rather than throwing:
   * a run that produced no reviewable diff is a normal outcome, and a missing
   * `.git` should not turn a completed run into a failed one.
   */
  diff(): Promise<DiffResult>;
}

export interface LeashCheck {
  allowed: boolean;
  reason?: string;
  rule?: string;
}

export class LeashDeniedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly rule?: string,
  ) {
    super(`Leash denied ${path}: ${reason}`);
    this.name = "LeashDeniedError";
  }
}

// ── Metering ────────────────────────────────────────────────────────────────

/**
 * Token and money accounting for one run.
 *
 * `record` both accumulates *and* emits a `cost` event, because the two things
 * that want this number want it at different times: the Desk wants it live,
 * and the run record wants one total. Reporting the same spend twice is not a
 * risk — the queue prefers the returned total over the summed stream when a
 * harness supplies both (see `reconcileCost`).
 */
export interface Meter {
  record(delta: CostDelta): void;
  total(): Cost;
}

export interface CostDelta {
  tokensIn?: number;
  tokensOut?: number;
  usd?: number;
}

// ── The run context ─────────────────────────────────────────────────────────

/**
 * Everything a harness is given, and nothing else.
 *
 * Notably absent: the bus, the store, the config, and the other Stations. A
 * harness that could reach those could not be replaced without understanding
 * them, which is the failure this interface exists to prevent.
 */
export interface RunContext {
  runId: RunId;
  /** The Station this invocation is acting as. */
  stationId: string;
  /** Its config — `model`, `role`, and the leash globs. */
  station: Station;
  /** The prompt, already assembled. The README calls this `ctx.brief`. */
  brief: string;
  workspace: Workspace;
  emit(event: HarnessEvent): void;
  meter: Meter;
  /**
   * Raise a Standby and wait for the operator.
   *
   * Rejects if the run is stopped while waiting, so a harness that simply
   * awaits it inherits correct stop behaviour without writing any.
   */
  ask(ask: string, kind?: "permission" | "hold"): Promise<StandbyAnswer>;
  /** Aborted on stop and on daemon shutdown. Ignoring it is how a quit hangs. */
  signal: AbortSignal;
}

/**
 * What a harness hands back.
 *
 * Every field is optional and the adapter fills the gaps: `status` defaults to
 * `done`, `cost` to the meter's total, and `diff` to absent. A harness that
 * streams everything and returns `{}` is valid.
 */
export interface RunResult {
  status?: RunStatus;
  cost?: Cost;
  diff?: DiffResult;
  /** Populated by reviewer-role harnesses. Gates (M5) read these. */
  verdicts?: Verdict[];
  /** Set alongside a `failed` status to explain it. */
  error?: string;
}

// ── Probing, usage, connectors ──────────────────────────────────────────────

/**
 * What `probe()` answers. `harness` is *not* here: the registry stamps the id
 * from the entry it called, so a harness cannot report another's identity, and
 * the README's two-field example stays literally correct.
 */
export type HarnessProbeResult = Omit<HarnessProbe, "harness">;

/**
 * One usage window a runtime reports — the README's limits strip, in data.
 *
 * Lives here rather than in core because nothing outside a harness produces
 * one yet. It moves to core when M2 puts it on the wire.
 */
export interface UsageWindow {
  /** Plan window label, e.g. `"5h"` or `"weekly"`. */
  window: string;
  /** Fraction consumed, `0`–`1`. */
  used: number;
  /** ISO 8601, UTC. Absent when the runtime does not say. */
  resetsAt?: string;
}

/** Where a runtime expects always-loaded context, so the Commons can project. */
export interface ContextFile {
  /** Relative to the scope root, e.g. `CLAUDE.md` or `AGENTS.md`. */
  path: string;
  scope: "project" | "user";
}

/** An MCP connector to register with a runtime. */
export interface Connector {
  name: string;
  command: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}

// ── The interface ───────────────────────────────────────────────────────────

export interface Harness {
  id: HarnessId;
  vendor: Vendor;
  /** Which Station roles this harness can play. */
  roles: readonly Role[];
  /** Is it installed, and is it logged in? Must not throw; report `error`. */
  probe(): Promise<HarnessProbeResult>;
  /** Plan usage for the limits strip (M2). `[]` is a valid answer. */
  usage(): Promise<UsageWindow[]>;
  contextFiles: readonly ContextFile[];
  /** Register MCP connectors (M4). A no-op is a valid implementation. */
  writeConnectors(connectors: readonly Connector[]): Promise<void>;
  run(ctx: RunContext): Promise<RunResult>;
}

/** Re-exported so a harness module needs one import, as in the README. */
export type { Cost, DiffStat, HarnessId, HarnessProbe, Role, Station, Vendor };
