/**
 * The ledger — what was spent, by run, by Station, by vendor, by day.
 *
 * Pure aggregation over run records, in `core` for the same reason `gate.ts`
 * and `limits.ts` are: it is arithmetic over data, and arithmetic that can
 * only be exercised through an HTTP server is arithmetic nobody checks
 * exhaustively.
 *
 * ## The thing this file is most likely to get wrong
 *
 * **`cacheRead` and `cacheWrite` are inside `tokensIn`, not beside it.** Every
 * total here adds `tokensIn` and carries the breakdown along; nothing adds the
 * three together. Getting that backwards would inflate every figure on the
 * page by roughly the cache hit rate, which on a warm repository is most of
 * it — and a ledger exists precisely so nobody is surprised by a bill.
 *
 * ## Runs recorded before per-Station costs existed
 *
 * `RunResultSummary.stations` arrived in Step 39. Every run on disk from
 * before it has a run-level `cost` and no split. Those runs are **not**
 * dropped and **not** attributed to their first Station: they appear in the
 * day and run totals, and their spend is reported separately as
 * `unattributed`. That is honest, it is visible, and it is what the Phase 7
 * gate run — recorded months earlier — actually is.
 */
import type { Cost, Run, StationCost } from "./types.js";

export interface LedgerTotals {
  tokensIn: number;
  tokensOut: number;
  /** Of `tokensIn`. Absent when no contributing run reported a breakdown. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Absent when nothing that contributed reported a price. */
  usd?: number;
  runs: number;
}

export interface LedgerRow extends LedgerTotals {
  /** A station id, a vendor, or a `YYYY-MM-DD` day, depending on the list. */
  key: string;
}

export interface LedgerRunRow extends LedgerTotals {
  runId: string;
  /** UTC day the run was created, `YYYY-MM-DD`. */
  day: string;
  status: Run["status"];
  prompt: string;
  cuesheetId?: string;
  /** False for runs recorded before per-Station costs existed. */
  attributed: boolean;
}

export interface Ledger {
  totals: LedgerTotals;
  /** Newest day first. */
  byDay: LedgerRow[];
  byVendor: LedgerRow[];
  byStation: LedgerRow[];
  /** Newest first, matching `GET /runs`. */
  runs: LedgerRunRow[];
  /**
   * Spend that belongs to a run but not to any Station.
   *
   * Non-zero only while runs from before Step 39 are still on disk. It is a
   * field rather than a footnote because `byStation` would otherwise not add
   * up to `totals`, and a reader who noticed that would be right to distrust
   * the whole page.
   */
  unattributed: LedgerTotals;
}

export interface LedgerOptions {
  /** Inclusive `YYYY-MM-DD`. Runs before this are ignored. */
  since?: string;
  /** Inclusive `YYYY-MM-DD`. */
  until?: string;
}

export function buildLedger(
  runs: readonly Run[],
  options: LedgerOptions = {},
): Ledger {
  const totals = zero();
  const unattributed = zero();
  const byDay = new Map<string, LedgerTotals>();
  const byVendor = new Map<string, LedgerTotals>();
  const byStation = new Map<string, LedgerTotals>();
  const runRows: LedgerRunRow[] = [];

  for (const run of runs) {
    const day = utcDay(run.createdAt);
    if (options.since !== undefined && day < options.since) continue;
    if (options.until !== undefined && day > options.until) continue;

    const stations = run.result?.stations;
    // The run's own `cost` is the authority for its total, not the sum of its
    // Stations'. The queue already reconciled a harness's reported total
    // against the metered stream once; re-deriving it here would quietly pick
    // a different winner and put two numbers for one run on one screen.
    add(totals, run.cost);
    bump(byDay, day, run.cost);

    if (stations === undefined || stations.length === 0) {
      add(unattributed, run.cost);
      runRows.push(runRow(run, day, false));
      continue;
    }

    for (const station of stations) {
      bump(byStation, station.stationId, station.cost);
      bump(byVendor, station.vendor, station.cost);
    }

    // A per-Station split that does not add up to the run's own total is not
    // an error worth hiding: it happens whenever the queue preferred a
    // harness's settled figure over the metered stream. The remainder goes to
    // `unattributed` so the columns reconcile and the gap is visible.
    const split = zero();
    for (const station of stations) add(split, station.cost);
    const remainder = difference(run.cost, split);
    if (remainder !== null) add(unattributed, remainder);

    runRows.push(runRow(run, day, true));
  }

  return {
    totals,
    byDay: rows(byDay).sort((a, b) => b.key.localeCompare(a.key)),
    byVendor: rows(byVendor).sort(bySpend),
    byStation: rows(byStation).sort(bySpend),
    runs: runRows,
    unattributed,
  };
}

/**
 * How much of a set of input tokens came from cache, or `null` when nobody
 * said.
 *
 * `null` rather than `0` throughout: a runtime that does not report a
 * breakdown has not told you its hit rate is zero, and a dashboard that draws
 * 0% for "unreported" is the same lie the limits strip refuses to tell.
 */
export function cacheHitRate(totals: LedgerTotals): number | null {
  if (totals.cacheRead === undefined) return null;
  if (totals.tokensIn <= 0) return null;
  return totals.cacheRead / totals.tokensIn;
}

// ── Internals ───────────────────────────────────────────────────────────────

function zero(): LedgerTotals {
  return { tokensIn: 0, tokensOut: 0, runs: 0 };
}

function add(into: LedgerTotals, cost: Cost | undefined): void {
  if (!cost) return;
  into.tokensIn += cost.tokensIn;
  into.tokensOut += cost.tokensOut;
  // Absent stays absent until something reports one. A run with no breakdown
  // contributing a zero would turn "unknown" into "none was cached".
  if (cost.cacheRead !== undefined)
    into.cacheRead = (into.cacheRead ?? 0) + cost.cacheRead;
  if (cost.cacheWrite !== undefined)
    into.cacheWrite = (into.cacheWrite ?? 0) + cost.cacheWrite;
  if (cost.usd !== undefined) into.usd = (into.usd ?? 0) + cost.usd;
}

function bump(
  map: Map<string, LedgerTotals>,
  key: string,
  cost: Cost | undefined,
): void {
  const entry = map.get(key) ?? zero();
  add(entry, cost);
  entry.runs += 1;
  map.set(key, entry);
}

function rows(map: Map<string, LedgerTotals>): LedgerRow[] {
  return [...map.entries()].map(([key, totals]) => ({ key, ...totals }));
}

/** Most expensive first, by tokens — the only figure every runtime reports. */
function bySpend(a: LedgerTotals, b: LedgerTotals): number {
  return b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut);
}

function runRow(run: Run, day: string, attributed: boolean): LedgerRunRow {
  return {
    runId: run.id,
    day,
    status: run.status,
    prompt: run.prompt,
    ...(run.cuesheetId !== undefined && { cuesheetId: run.cuesheetId }),
    attributed,
    tokensIn: run.cost.tokensIn,
    tokensOut: run.cost.tokensOut,
    ...(run.cost.cacheRead !== undefined && { cacheRead: run.cost.cacheRead }),
    ...(run.cost.cacheWrite !== undefined && {
      cacheWrite: run.cost.cacheWrite,
    }),
    ...(run.cost.usd !== undefined && { usd: run.cost.usd }),
    runs: 1,
  };
}

/** `whole - part`, or `null` when there is nothing left over. */
function difference(whole: Cost, part: LedgerTotals): Cost | null {
  const tokensIn = whole.tokensIn - part.tokensIn;
  const tokensOut = whole.tokensOut - part.tokensOut;
  const usd = whole.usd === undefined ? undefined : whole.usd - (part.usd ?? 0);
  if (tokensIn === 0 && tokensOut === 0 && (usd === undefined || usd === 0)) {
    return null;
  }
  // Clamped at zero: a per-Station sum that *exceeds* the run's settled total
  // means the queue preferred the harness's figure over the stream, which is
  // the documented behaviour and not a debt owed to anybody.
  return {
    tokensIn: Math.max(0, tokensIn),
    tokensOut: Math.max(0, tokensOut),
    ...(usd !== undefined && { usd: Math.max(0, usd) }),
  };
}

/** `2026-09-16`. UTC, so a ledger does not shift under a traveller. */
export function utcDay(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "unknown";
  return new Date(parsed).toISOString().slice(0, 10);
}

export type { StationCost };
