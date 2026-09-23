/**
 * Runs that were still going when the process died.
 *
 * A clean shutdown marks the active run `interrupted` and refuses the queued
 * ones — `queue.shutdown()` does that, and both `cuesheetd`'s signal handlers
 * and the app's `before-quit` call it. None of that runs on a force-quit, a
 * power cut, or an `Activity Monitor → Force Quit`, and those are precisely
 * the cases the guarantee exists for. What is left on disk afterwards is a
 * `run.json` that says `running` forever: a record the Desk renders as a live
 * run with no process behind it, and the corrupt state alpha's exit criteria
 * name by hand.
 *
 * So the *next* boot fixes it. This lives in the daemon rather than in the
 * Electron shell because the CLI and a standalone `cuesheetd` get killed the
 * same way, and a fix in the app would leave the bug in every other entry
 * point.
 *
 * **The safety argument is the port.** `startDaemon` refuses to boot while a
 * live daemon holds it, so anything still marked non-terminal by the time
 * this runs belongs to a process that is gone. If that ever stops being true
 * — a second daemon on another port, an attach mode, a shared runs directory
 * across machines — this function starts stealing live runs, and it must grow
 * an ownership check before that happens.
 */
import { isTerminalStatus, type RunId } from "@cuesheet/core";
import type { RunStore } from "./store.js";

/**
 * How far back to look **when the store cannot be asked directly**.
 *
 * The file store has no "give me the unfinished ones" query, so this reads run
 * records newest-first and stops. Reconciling *every* run would make boot
 * O(all runs ever) — the second place the file store's scaling shows through,
 * after `list()` itself, and the second reason the plan put SQLite behind
 * `RunStore` before beta.
 *
 * Step 52 took that reason away for the default store and left the window
 * here rather than deleting it: a `RunStore` with `unfinished()` is asked for
 * exactly the stranded runs, at any age, and one without keeps this bounded
 * scan and its known hole — a run left `running` further back than this stays
 * that way. That is a real difference between the backends and it is stated
 * in the interface rather than hidden here.
 */
export const RECONCILE_SCAN_LIMIT = 200;

/** What lands in the record, so the reason survives longer than this process. */
export const INTERRUPTED_REASON =
  "Cuesheet stopped before this run finished. Its events are whatever was written before that.";

export interface ReconcileOptions {
  store: RunStore;
  /** Only consulted for a store with no `unfinished()`. */
  limit?: number;
}

/**
 * Mark every non-terminal run `interrupted`. Returns the ids it changed.
 *
 * The event log is not touched: a partial `events.jsonl` — last line possibly
 * half-written, which `readEvents` already tolerates — is the honest record of
 * what happened, and appending a synthetic `done` to tidy it up would be
 * inventing the part nobody saw.
 */
export async function reconcileInterruptedRuns({
  store,
  limit = RECONCILE_SCAN_LIMIT,
}: ReconcileOptions): Promise<RunId[]> {
  const stranded = store.unfinished
    ? await store.unfinished()
    : (await store.list(limit)).filter((run) => !isTerminalStatus(run.status));

  const repaired: RunId[] = [];
  for (const run of stranded) {
    // `finish` without a `cost` keeps whatever the run had accumulated. A
    // run that burned tokens before the crash still burned them, and zeroing
    // the ledger to make the record tidy would be a lie in the user's favour
    // exactly until they got the bill.
    await store.finish(run.id, {
      status: "interrupted",
      error: INTERRUPTED_REASON,
    });
    repaired.push(run.id);
  }

  return repaired;
}
