/**
 * Domain vocabulary.
 *
 * The README's "Core concepts" table is the spec — the words there are the
 * words here, deliberately. Anything renamed in code is a word the docs and
 * the UI then have to translate, forever.
 *
 * Two kinds of type live in this package and they are split on purpose:
 *
 * - **Runtime / wire types** (this file) are hand-written. They are what the
 *   daemon emits and what the Desk and the phone consume.
 * - **Config-shaped types** (`config.ts`) are inferred from their zod schemas.
 *   `exactOptionalPropertyTypes` is on, and a hand-written `{ model?: string }`
 *   is not assignable from zod's `{ model?: string | undefined }`. Rather than
 *   maintain two shapes that must agree, the schema is authoritative and the
 *   type falls out of it.
 *
 * The `Harness` *interface* is not here — it lands in `packages/harness`
 * (Step 13). Core only owns the identifier and the vocabulary around it;
 * putting the interface here would make core depend on spawning and I/O.
 */

/** What a Station is *for*. Roles change permissions, not just prompts. */
export const ROLES = ["engineer", "reviewer", "worker", "caller"] as const;
export type Role = (typeof ROLES)[number];

/**
 * The integration for one runtime. Open, not an enum: a harness is meant to be
 * replaceable and third-party harnesses can live outside this repo.
 */
export type HarnessId = string;

/** Built-in and planned harnesses, for probe ordering and UI hints only. */
export const BUILTIN_HARNESS_IDS = [
  "claude-code",
  "codex",
  "ollama",
] as const satisfies readonly HarnessId[];

/**
 * Who trained the model behind a harness. Free-form for the same reason
 * `HarnessId` is — but it carries weight: `distinct_vendors = 2` on a Gate is
 * an equality check over this field, and it is the entire point of Gates.
 */
export type Vendor = string;

// ── Runs ────────────────────────────────────────────────────────────────────

/**
 * `held` is a Gate outcome, `standby` is a question for you, `stopped` is you
 * pressing stop, and `interrupted` is the process dying under a run. They are
 * distinct because a Run left `running` forever is the failure mode Step 23
 * exists to prevent — a crash must land somewhere terminal and readable.
 */
export type RunStatus =
  | "queued"
  | "running"
  | "standby"
  | "held"
  | "done"
  | "failed"
  | "stopped"
  | "interrupted";

/** Terminal statuses. A Run in one of these will never change again. */
export const TERMINAL_RUN_STATUSES = [
  "done",
  "failed",
  "stopped",
  "interrupted",
  // A Hold is the end of a run, not a pause in one. The Gate asked, a human
  // answered, and nothing is waiting: "go" carries the run on to `done`, "no"
  // stops it here. A non-terminal `held` would be a state with no actor —
  // tiles lit for work that stopped, and a boot reconcile correctly marking it
  // `interrupted`, which is the proof it was never meant to outlive the
  // process. Releasing a Hold is a *new* run, not a resumption of this one.
  "held",
] as const satisfies readonly RunStatus[];

export function isTerminalStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/**
 * What one run, or one Station within it, spent.
 *
 * `tokensIn` is the **total billed input**, cache included, and that has been
 * true since the `claude-code` mapper was written — counting only fresh input
 * reported 17 tokens for a run that consumed 50,270. What changed in Step 39
 * is that the total is no longer the *only* thing said.
 *
 * **`cacheRead` and `cacheWrite` are a breakdown, not addends.** They are
 * already inside `tokensIn`; adding them to it would double-count. They exist
 * because cached input is billed at a fraction of fresh input, so two runs
 * with identical `tokensIn` can differ severalfold in price — and a ledger
 * that cannot say which one you just paid for can report what a run cost but
 * never why.
 *
 * Both are optional, and absent means *the runtime did not report a
 * breakdown*, which is a different statement from zero. `codex` reports only
 * a cache read; a local model reports neither.
 */
export interface Cost {
  /** Total billed input, cache included. */
  tokensIn: number;
  tokensOut: number;
  /** Of `tokensIn`, how much was served from cache. Absent if unreported. */
  cacheRead?: number;
  /** Of `tokensIn`, how much was written *into* cache. Absent if unreported. */
  cacheWrite?: number;
  usd?: number;
}

/**
 * What one Station spent inside a run.
 *
 * On the run record rather than derived from the event stream, and the reason
 * is the same one that keeps `list()` answering off `readdir`: deriving it
 * would mean opening every run's `events.jsonl` to draw one chart, and
 * `reconcileInterruptedRuns` already carries a comment about being O(all runs
 * ever). The executor knows the station, the harness, the vendor and the
 * meter's total at the moment the step ends; writing four fields then is free.
 *
 * **Absent on every run recorded before Step 39.** The ledger treats those as
 * attributable to a run and a day but not to a Station — which is honest, and
 * is not the same as attributing them to the first Station in the list.
 */
export interface StationCost {
  stationId: string;
  harness: HarnessId;
  vendor: Vendor;
  cost: Cost;
  durationMs?: number;
  /**
   * The Station this one stood in for, when `when_capped` routed around a cap.
   *
   * On the record rather than only in the log, because a fallback changes who
   * did the work — and a ledger that shows `qwen` where the cuesheet says
   * `codex`, with no explanation, is a ledger somebody will file a bug about.
   */
  substitutedFor?: string;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/**
 * What one Gate decided, and why.
 *
 * Kept on the run summary rather than sent as its own event: a Gate that
 * *passes* raises no standby and changes no status, so without this it would
 * leave no trace at all — and "why did this pass?" is a question a safety
 * feature has to be able to answer months later. Adding a field to a record
 * every client already reads is additive; adding a variant to `RunEvent` is a
 * case every client must then handle.
 */
export interface GateReport {
  gate: string;
  outcome: "pass" | "hold" | "skipped";
  reasons: string[];
  /** A human was asked, and said carry on anyway. */
  overridden?: boolean;
}

/** What a `done` event carries: enough to render a run row without a re-read. */
export interface RunResultSummary {
  status: RunStatus;
  cost: Cost;
  durationMs: number;
  /** Per-Station spend, in cue order. Absent on runs recorded before Step 39. */
  stations?: StationCost[];
  /** Absent when the run touched nothing. */
  diff?: DiffStat;
  verdicts?: Verdict[];
  /** Every Gate the run passed through, in cue order. */
  gates?: GateReport[];
  /**
   * Why the run ended this way, when the status alone does not say it.
   *
   * A `held` run is the case this exists for: it ends *successfully* as far
   * as the queue is concerned — the executor returned, nothing threw — so
   * without this the record would carry a status and no sentence, and the
   * README's promise is a Hold "with the finding attached".
   */
  error?: string;
}

/**
 * One execution of a cuesheet. Durable, replayable, costed.
 *
 * `kind` marks the seam for Incidents (README M7 · On-Call): an externally
 * triggered Run is the same record with stricter defaults, not a new type.
 */
export interface Run {
  id: RunId;
  kind: "prompt" | "incident";
  status: RunStatus;
  prompt: string;
  /** Which cuesheet was executed; absent for a bare single-station prompt. */
  cuesheetId?: string;
  /** Stations participating, in cue order. */
  stationIds: string[];
  workspace: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cost: Cost;
  result?: RunResultSummary;
  /** Set when `status` is `failed`. */
  error?: string;
}

/**
 * Run identifier. Timestamp-prefixed so a lexical sort is a chronological
 * sort — the run store lists newest-first off the directory names alone.
 */
export type RunId = string;

// ── Events ──────────────────────────────────────────────────────────────────

/**
 * The wire format for everything: the WebSocket stream, `events.jsonl`, and
 * later the phone. A discriminated union so a client `switch` is exhaustive
 * and adding a variant is a compile error at every consumer.
 *
 * Every variant carries `runId` and `at` (ISO 8601, UTC) — without those an
 * event cannot be filed against a run or ordered after a reconnect.
 */
export type RunEvent =
  | { t: "status"; at: string; runId: RunId; status: RunStatus }
  | { t: "text"; at: string; runId: RunId; stationId: string; chunk: string }
  | {
      t: "tool";
      at: string;
      runId: RunId;
      stationId: string;
      name: string;
      input: unknown;
    }
  | {
      t: "file";
      at: string;
      runId: RunId;
      stationId: string;
      path: string;
      op: "read" | "write";
    }
  | { t: "standby"; at: string; runId: RunId; standbyId: string; ask: string }
  | { t: "denial"; at: string; runId: RunId; reason: string; path?: string }
  | {
      t: "cost";
      at: string;
      runId: RunId;
      stationId: string;
      tokensIn: number;
      tokensOut: number;
      usd?: number;
    }
  /**
   * A reviewer's judgement on the work so far.
   *
   * Carries the whole `Verdict` rather than a decision word: the Desk has to
   * show *why* something was blocked, and a client that only has "fail" has
   * to go and fetch the findings to say anything useful.
   *
   * There is deliberately no matching `gate` event. A Gate's outcome is
   * already observable — the standby it raises when it fails, the run's
   * terminal status, and these verdicts — and every client has to handle this
   * union exhaustively, so a variant carrying derivable state is a tax on all
   * of them.
   */
  | {
      t: "verdict";
      at: string;
      runId: RunId;
      stationId: string;
      verdict: Verdict;
    }
  | { t: "done"; at: string; runId: RunId; result: RunResultSummary }
  | { t: "error"; at: string; runId: RunId; message: string };

export type RunEventType = RunEvent["t"];

/** All event discriminants, for validation and for UI filter chips. */
export const RUN_EVENT_TYPES = [
  "status",
  "text",
  "tool",
  "file",
  "standby",
  "denial",
  "cost",
  "verdict",
  "done",
  "error",
] as const satisfies readonly RunEventType[];

// ── Standbys ────────────────────────────────────────────────────────────────

/** The whole interaction: your phone buzzes, you tap GO. */
export type StandbyAnswer = "go" | "no";

/**
 * A Run paused, waiting on you — the moment an agent needs a permission you
 * have not pre-granted, or a Gate held the diff and wants a decision.
 */
export interface Standby {
  id: string;
  runId: RunId;
  stationId?: string;
  /** What is being asked, in one line, readable one-handed. */
  ask: string;
  /** Why the run stopped: a leash denial, or a Gate's hold. */
  kind: "permission" | "hold";
  at: string;
  answer?: StandbyAnswer;
  answeredAt?: string;
}

// ── Verdicts ────────────────────────────────────────────────────────────────

export type VerdictDecision = "pass" | "fail" | "abstain";

/**
 * Finding categories a Gate can treat as blocking. Open, because the README's
 * `blocking` list is user-configurable TOML (`security`, `correctness`,
 * `data-loss`, `unreproduced`, and whatever a team adds).
 */
export type FindingCategory = string;

export interface Finding {
  category: FindingCategory;
  severity: "info" | "warn" | "block";
  summary: string;
  path?: string;
  line?: number;
}

/**
 * One reviewer's opinion on a Run's diff. `vendor` is denormalized onto the
 * verdict deliberately: `distinct_vendors` must be checkable from stored
 * verdicts alone, long after the config that produced them has changed.
 */
export interface Verdict {
  id: string;
  runId: RunId;
  stationId: string;
  harness: HarnessId;
  vendor: Vendor;
  decision: VerdictDecision;
  findings: Finding[];
  at: string;
}

// ── Plan usage ──────────────────────────────────────────────────────────────

/**
 * One usage window a runtime reports — the README's limits strip, in data.
 *
 * Moved here from `@cuesheet/harness`, where it carried a comment saying it
 * would move when the limits milestone put it on the wire. This is that.
 *
 * **It is a union, and that is the entire design.** Three findings from the
 * shipped harnesses say a single `used: number` cannot be honest:
 *
 * - `claude-code` reports a *status*, not a fraction, and only from inside a
 *   run. `allowed` means "not yet blocked", which is not the same claim as
 *   "0% consumed" — and a bar drawn at 0% is a confident lie in the direction
 *   that gets someone cut off mid-task.
 * - `codex` reports no plan window at all. Its silence has to look different
 *   from a measurement.
 * - A local model cannot run out. A percentage there is a lie in the opposite
 *   direction, and a bar chart cannot draw it at all.
 *
 * So `used` exists only on the variant that measured something. The strip
 * cannot render a fabricated percentage because there is no field to read.
 *
 * `seenAt` is on the two variants that come from an observation, and it is
 * load-bearing rather than diagnostic. `claude-code`'s numbers exist only
 * *inside* a run, so the honest answer to "what is your five-hour window" is
 * always "here is what it said when it last spoke, and that was then". A
 * five-hour window observed forty minutes ago is not a current fact, and a
 * strip that draws it as one is exactly the authoritative-looking screen this
 * phase exists to avoid. `unmetered` carries no time because it is not an
 * observation — a local model has no cap whether or not anyone looked.
 */
export type UsageWindow =
  /** A real fraction of a real cap, `0`–`1`. */
  | {
      window: string;
      state: "measured";
      used: number;
      resetsAt?: string;
      seenAt?: string;
    }
  /** The runtime says only that it has not cut you off yet. */
  | { window: string; state: "not-blocked"; resetsAt?: string; seenAt?: string }
  /** There is no cap. A local model, and the row a percentage cannot describe. */
  | { window: string; state: "unmetered" }
  /** Nobody said. Distinct from every answer above, including from silence. */
  | { window: string; state: "unknown"; reason?: string };

export type UsageState = UsageWindow["state"];

/**
 * What one harness reports, as the wire carries it.
 *
 * `vendor` rather than only `harness` because the strip groups by plan, and a
 * plan belongs to a vendor: two Stations on `claude-code` share one five-hour
 * window, and showing it twice would read as twice the budget.
 *
 * Freshness lives on the windows, not here — see `seenAt` above. An envelope
 * timestamp would be the time of the *poll*, and reporting when we asked as
 * though it were when they answered is the specific error this phase's own
 * prose warns about.
 *
 * `windows` is never empty. A harness with nothing to say gets one `unknown`
 * row, because a missing row and a row reading "unknown" are the two answers
 * that must not collapse into each other.
 */
export interface HarnessUsage {
  harness: HarnessId;
  vendor: Vendor;
  windows: UsageWindow[];
}

// ── Station liveness ────────────────────────────────────────────────────────

/**
 * The result of asking a harness whether it is usable. Separate from the
 * configured Station: config is what you wrote, this is what is true right now.
 */
export interface HarnessProbe {
  harness: HarnessId;
  installed: boolean;
  authed: boolean;
  /** Reported by `--version`, when the binary resolved. */
  version?: string;
  /** Absolute path the binary resolved to, for diagnostics. */
  binPath?: string;
  /**
   * Models this runtime has available *right now*, when it can say.
   *
   * Absent on every harness whose model comes from static config, which is all
   * of them but `ollama` — and absent is not `[]`. `[]` is the real answer to
   * "a server is running and nothing is pulled", and a Desk has to be able to
   * say that instead of offering an empty picker indistinguishable from one it
   * was never given a list for.
   *
   * A hint for a picker, never a check. It goes stale between one probe and
   * the next: an `ollama rm` while the Desk is open is enough.
   */
  models?: readonly string[];
  /** Why the probe failed, when it did. */
  error?: string;
}
