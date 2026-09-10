/**
 * The executor seam.
 *
 * The queue has to run *something* now, but harnesses are Phase 3. Rather
 * than pull the `Harness` interface forward — which would put spawning and
 * I/O behind the daemon's queue before either is designed, and recreate the
 * core↔harness cycle Step 5 was written to avoid — the queue depends on this
 * narrow function type.
 *
 * The `mock` and `claude-code` harnesses are adapted onto `RunExecutor` by
 * `harness-executor.ts`, which is the one composition root in this package and
 * the only file here that imports a harness. Everything else — the queue, the
 * store, the bus — sees nothing but this function type, so the daemon stays
 * testable with a closure.
 */
import type {
  Cost,
  Run,
  RunEvent,
  RunResultSummary,
  Standby,
  StandbyAnswer,
} from "@cuesheet/core";

export interface ExecutionContext {
  run: Run;
  /**
   * Publish an event. Fans out to the bus and appends to the run log; the
   * executor does not know or care which. Synchronous — a harness streaming
   * stdout should never have to await a log write.
   */
  emit(event: RunEvent): void;
  /**
   * Aborted when the run is stopped or the daemon shuts down. An executor
   * that ignores this is the reason a run hangs on quit.
   */
  signal: AbortSignal;
  /**
   * Ask the operator a question and wait. Resolves with their answer, or
   * rejects if the run is stopped while waiting.
   */
  ask(request: Omit<StandbyRequest, "runId">): Promise<StandbyAnswer>;
  /**
   * Hand over the run's unified diff, to be written to `diff.patch`.
   *
   * Separate from the returned `RunResultSummary` on purpose. That summary is
   * the payload of the `done` event, and a patch can be megabytes — putting it
   * there would push a whole diff through the WebSocket to every connected
   * client on every run. The summary carries the `DiffStat`; the patch goes to
   * disk and is fetched on demand by `GET /runs/:id`.
   *
   * Last call wins, so an executor running several Stations can record once at
   * the end rather than merging.
   */
  recordDiff(patch: string): void;
}

export type RunExecutor = (ctx: ExecutionContext) => Promise<RunResultSummary>;

export interface StandbyRequest {
  runId: string;
  ask: string;
  kind: Standby["kind"];
  stationId?: string;
}

export const ZERO_COST: Cost = { tokensIn: 0, tokensOut: 0 };

/**
 * The default executor: emits a `status` and returns immediately.
 *
 * Not a placeholder to be deleted — it is what makes Step 11's done-when
 * ("two rapid enqueues run sequentially, both produce complete run records")
 * provable before a single harness exists, and it stays useful afterwards as
 * the thing the queue's own tests run against.
 */
export const noopExecutor: RunExecutor = async (ctx) => {
  const started = Date.now();
  ctx.emit({
    t: "text",
    at: new Date().toISOString(),
    runId: ctx.run.id,
    stationId: ctx.run.stationIds[0] ?? "none",
    chunk: "No harness is configured, so nothing ran.",
  });
  return {
    status: "done",
    cost: { ...ZERO_COST },
    durationMs: Date.now() - started,
  };
};
