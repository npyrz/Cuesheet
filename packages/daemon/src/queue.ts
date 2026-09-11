/**
 * The queue — single-concurrency FIFO.
 *
 * One run at a time, cues in declared order, deliberately. Parallel stations
 * are a later problem and they would dominate debugging time now: almost every
 * confusing failure in a system like this is two runs touching one workspace.
 *
 * The queue is also the only place that knows how an event reaches disk. An
 * executor calls `ctx.emit`; the queue fans that out to the bus *and* appends
 * it to the run log, so no harness ever has to remember to do both.
 *
 * **Ordering, stated precisely.** A run takes its place in the queue after its
 * store record is written, so two *genuinely concurrent* `enqueue` calls race
 * for position and which one goes first is not defined. Sequential calls run
 * in call order. The guarantee that matters — and the one the single-
 * concurrency promise rests on — is that no two runs ever overlap. Making
 * concurrent arrivals strictly first-come-first-served would mean reserving a
 * slot before the record exists, which is a real change and belongs with
 * parallel stations rather than ahead of them.
 */
import {
  type Cost,
  type Run,
  type RunEvent,
  type RunId,
  type RunResultSummary,
  type RunStatus,
} from "@cuesheet/core";
import type { EventBus } from "./bus.js";
import type { RunStore } from "./store.js";
import { ZERO_COST, type RunExecutor } from "./executor.js";
import { StandbyAbandonedError, type StandbyRegistry } from "./standby.js";

export interface EnqueueInput {
  prompt: string;
  workspace: string;
  cuesheetId?: string;
  stationIds?: string[];
  kind?: Run["kind"];
}

export type StopOutcome =
  "stopped-running" | "stopped-queued" | "not-found" | "already-finished";

export interface RunQueue {
  enqueue(input: EnqueueInput): Promise<Run>;
  stop(runId: RunId): Promise<StopOutcome>;
  /** Resolves when nothing is running and nothing is pending. */
  idle(): Promise<void>;
  /**
   * Step 23's clean shutdown: abort the active run, refuse the pending ones,
   * and mark them `interrupted` — never leave a run `running` forever.
   */
  shutdown(): Promise<void>;
  activeRunId(): RunId | null;
  pendingRunIds(): RunId[];
}

export interface RunQueueOptions {
  store: RunStore;
  bus: EventBus;
  standbys: StandbyRegistry;
  executor: RunExecutor;
  now?: () => Date;
}

interface Pending {
  run: Run;
}

export function createRunQueue(options: RunQueueOptions): RunQueue {
  const { store, bus, standbys, executor } = options;
  const now = options.now ?? (() => new Date());

  const pending: Pending[] = [];
  let active: { run: Run; controller: AbortController } | null = null;
  let stopRequested = false;
  let shuttingDown = false;
  let pump: Promise<void> = Promise.resolve();
  const idleWaiters: Array<() => void> = [];

  function stamp(): string {
    return now().toISOString();
  }

  /**
   * Publish an event: bus first, disk second.
   *
   * The bus call is synchronous so a UI sees streamed text immediately; the
   * append is fire-and-forget because the store serializes writes per run,
   * which means `finish` is already ordered after every append it issued.
   */
  function publish(event: RunEvent): void {
    bus.emit(event);
    void store.append(event.runId, event).catch((error: unknown) => {
      console.error(
        `[cuesheetd] could not append event for ${event.runId}:`,
        error,
      );
    });
  }

  function emitStatus(runId: RunId, status: RunStatus): void {
    publish({ t: "status", at: stamp(), runId, status });
  }

  function settleIdle(): void {
    if (active !== null || pending.length > 0) return;
    while (idleWaiters.length > 0) idleWaiters.pop()?.();
  }

  async function runOne(run: Run): Promise<void> {
    const controller = new AbortController();
    active = { run, controller };
    stopRequested = false;

    const startedAt = stamp();
    await store.update(run.id, { status: "running", startedAt });
    emitStatus(run.id, "running");

    // Cost is accumulated in memory and written once, at the end. Writing
    // `run.json` on every `cost` event would be a file write per token chunk.
    const cost: Cost = { ...ZERO_COST };
    let sawUsd = false;

    const started = Date.now();
    let result: RunResultSummary | null = null;
    let failure: unknown = null;
    // Held here rather than on the summary: a patch can be megabytes, and the
    // summary is the `done` event's payload. Stats go on the wire, the patch
    // goes to disk.
    let patch: string | null = null;

    try {
      result = await executor({
        run,
        signal: controller.signal,
        recordDiff(text) {
          patch = text;
        },
        emit(event) {
          if (event.t === "cost") {
            cost.tokensIn += event.tokensIn;
            cost.tokensOut += event.tokensOut;
            if (event.usd !== undefined) {
              cost.usd = (cost.usd ?? 0) + event.usd;
              sawUsd = true;
            }
          }
          publish(event);
        },
        ask(request) {
          const opened = standbys.open({ ...request, runId: run.id });
          publish({
            t: "standby",
            at: stamp(),
            runId: run.id,
            standbyId: opened.standby.id,
            ask: opened.standby.ask,
          });
          emitStatus(run.id, "standby");
          return opened.answer.then((answer) => {
            emitStatus(run.id, "running");
            return answer;
          });
        },
      });
    } catch (error) {
      failure = error;
    } finally {
      standbys.abandonRun(
        run.id,
        "The run ended before this standby was answered.",
      );
    }

    const finalCost: Cost = sawUsd
      ? cost
      : { tokensIn: cost.tokensIn, tokensOut: cost.tokensOut };

    if (failure !== null) {
      // Why the run ended decides where it lands, and the three cases are
      // genuinely different to a person reading the list later.
      const status: RunStatus = shuttingDown
        ? "interrupted"
        : stopRequested
          ? "stopped"
          : "failed";
      const message = errorText(failure);
      if (status === "failed" || !isAbort(failure)) {
        publish({ t: "error", at: stamp(), runId: run.id, message });
      }
      await store.finish(run.id, {
        status,
        cost: finalCost,
        // A run that died still gets whatever diff it managed to produce. The
        // partial work is usually the most useful thing on the page.
        ...(patch !== null && { diff: patch }),
        ...(status === "failed" && { error: message }),
      });
      emitStatus(run.id, status);
    } else {
      const summary: RunResultSummary = result ?? {
        status: "done",
        cost: finalCost,
        durationMs: Date.now() - started,
      };
      // A stop that lands between the executor returning and here is still a
      // stop; the operator pressed the button and the list must say so.
      const status: RunStatus = shuttingDown
        ? "interrupted"
        : stopRequested
          ? "stopped"
          : summary.status;
      const resolved: RunResultSummary = {
        ...summary,
        status,
        cost: reconcileCost(summary.cost, finalCost),
      };
      publish({ t: "done", at: stamp(), runId: run.id, result: resolved });
      await store.finish(run.id, {
        status,
        result: resolved,
        cost: resolved.cost,
        ...(patch !== null && { diff: patch }),
      });
      emitStatus(run.id, status);
    }

    active = null;
  }

  function schedule(): void {
    pump = pump.then(async () => {
      while (pending.length > 0 && !shuttingDown) {
        const next = pending.shift();
        if (!next) break;
        try {
          await runOne(next.run);
        } catch (error) {
          // `runOne` handles executor failure itself; reaching here means the
          // *store* failed. Losing the queue over it would strand every
          // subsequent run, so log and carry on.
          console.error(
            `[cuesheetd] run ${next.run.id} could not be recorded:`,
            error,
          );
          active = null;
        }
      }
      settleIdle();
    });
  }

  return {
    async enqueue(input) {
      const run = await store.create({
        prompt: input.prompt,
        workspace: input.workspace,
        ...(input.cuesheetId !== undefined && { cuesheetId: input.cuesheetId }),
        ...(input.stationIds !== undefined && { stationIds: input.stationIds }),
        ...(input.kind !== undefined && { kind: input.kind }),
      });
      pending.push({ run });
      emitStatus(run.id, "queued");
      schedule();
      return run;
    },

    async stop(runId) {
      if (active?.run.id === runId) {
        stopRequested = true;
        active.controller.abort();
        standbys.abandonRun(runId, "The run was stopped.");
        return "stopped-running";
      }

      // The case the naive implementation misses: a run still in the queue has
      // no controller to abort, and leaving it there means it starts a moment
      // after the operator stopped it.
      const index = pending.findIndex((entry) => entry.run.id === runId);
      if (index >= 0) {
        const [removed] = pending.splice(index, 1);
        if (removed) {
          await store.finish(removed.run.id, {
            status: "stopped",
            cost: { ...ZERO_COST },
          });
          emitStatus(removed.run.id, "stopped");
        }
        settleIdle();
        return "stopped-queued";
      }

      const stored = await store.get(runId);
      if (!stored) return "not-found";
      return "already-finished";
    },

    idle() {
      if (active === null && pending.length === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.push(resolve));
    },

    async shutdown() {
      shuttingDown = true;

      const queued = pending.splice(0, pending.length);
      for (const entry of queued) {
        await store.finish(entry.run.id, {
          status: "interrupted",
          cost: { ...ZERO_COST },
        });
        emitStatus(entry.run.id, "interrupted");
      }

      if (active) {
        active.controller.abort();
        standbys.abandonRun(active.run.id, "The daemon is shutting down.");
      }

      await pump;
      settleIdle();
    },

    activeRunId() {
      return active?.run.id ?? null;
    },

    pendingRunIds() {
      return pending.map((entry) => entry.run.id);
    },
  };
}

/**
 * Decide the run's cost when the harness reports a total *and* streamed
 * deltas, which is the normal case and which the two can disagree about.
 *
 * The harness's own total wins when it reports one: it knows its billing, and
 * a sum of streamed deltas can double-count or miss a final settlement. But a
 * harness that streams costs and returns an empty total — common for one that
 * never bothers to sum — must not silently erase observed spend. So an empty
 * summary falls back to the accumulated stream.
 *
 * The asymmetry is deliberate: M2's limits ledger reads this field, and
 * under-counting is the direction that lets someone blow past a cap.
 */
function reconcileCost(reported: Cost, accumulated: Cost): Cost {
  const reportedAnything =
    reported.tokensIn > 0 ||
    reported.tokensOut > 0 ||
    reported.usd !== undefined;
  return reportedAnything ? reported : accumulated;
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    error instanceof StandbyAbandonedError
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
