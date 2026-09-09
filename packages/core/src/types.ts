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
] as const satisfies readonly RunStatus[];

export function isTerminalStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/** Token and money totals. `usd` is absent when the harness cannot price it. */
export interface Cost {
  tokensIn: number;
  tokensOut: number;
  usd?: number;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** What a `done` event carries: enough to render a run row without a re-read. */
export interface RunResultSummary {
  status: RunStatus;
  cost: Cost;
  durationMs: number;
  /** Absent when the run touched nothing. */
  diff?: DiffStat;
  verdicts?: Verdict[];
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
  /** Why the probe failed, when it did. */
  error?: string;
}
