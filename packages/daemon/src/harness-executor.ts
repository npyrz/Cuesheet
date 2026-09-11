/**
 * The adapter: a `Harness` seen as something the queue can run.
 *
 * This is the composition root, and it lives here rather than in
 * `packages/harness` for a dependency reason. The adapter needs the queue's
 * `RunExecutor`/`ExecutionContext` types, which live in this package; putting
 * it beside the harnesses would mean `@cuesheet/harness` importing
 * `@cuesheet/daemon`, and a cycle between exactly the two packages Step 5
 * split apart. The daemon already declares a dependency on the harness
 * package, so this direction is the acyclic one.
 *
 * The note at the top of `executor.ts` says nothing in this package imports a
 * harness. This file is the deliberate exception — a composition root has to
 * know both sides — and it is the *only* one: the queue, the store, and the
 * bus still see nothing but a closure.
 */
import {
  createMeter,
  createWorkspace,
  diffWorkspace,
  type Harness,
  type HarnessEvent,
  type HarnessRegistry,
  type RunResult,
} from "@cuesheet/harness";
import {
  expandHome,
  hostEnv,
  type Cost,
  type HostEnv,
  type LoadedConfig,
  type RunEvent,
  type RunResultSummary,
  type RunStatus,
  type Station,
} from "@cuesheet/core";
import type { ExecutionContext, RunExecutor } from "./executor.js";
import { ZERO_COST } from "./executor.js";

export interface HarnessExecutorOptions {
  registry: HarnessRegistry;
  /** Read at run time, not captured, so `reloadConfig()` affects the next run. */
  config: () => LoadedConfig;
  env?: HostEnv;
}

export class NoStationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoStationError";
  }
}

/**
 * Build the executor the daemon actually runs.
 *
 * Stations execute **in cue order, one at a time**, which is Step 11's promise
 * applied one level down: a cuesheet's steps are sequential for the same
 * reason runs are, because two agents in one workspace is where the confusing
 * failures live.
 */
export function createHarnessExecutor(
  options: HarnessExecutorOptions,
): RunExecutor {
  const env = options.env ?? hostEnv();

  return async (ctx: ExecutionContext): Promise<RunResultSummary> => {
    const started = Date.now();
    const loaded = options.config();
    const stations = resolveStations(loaded, ctx.run.stationIds);

    if (stations.length === 0) {
      throw new NoStationError(
        ctx.run.stationIds.length === 0
          ? "This run has no Station. Add one in the Desk, or a [[station]] block to cuesheet.toml."
          : `No configured Station matches ${ctx.run.stationIds.join(", ")}.`,
      );
    }

    const cost: Cost = { ...ZERO_COST };
    let status: RunStatus = "done";
    let error: string | undefined;
    let lastResult: RunResult | undefined;

    // The loop is wrapped rather than left to reject, because the two shipped
    // harnesses disagree about how a stop arrives: `claude-code` returns
    // `{ status: "stopped" }` while a harness awaiting its own timers throws an
    // `AbortError`. Both must still get their diff recorded below — a stopped
    // run's partial work is the most useful thing on the page — so the throw is
    // caught here and re-thrown after, unchanged.
    let thrown: unknown = null;
    try {
      for (const station of stations) {
        if (ctx.signal.aborted) {
          status = "stopped";
          break;
        }

        const harness = options.registry.get(station.harness);
        if (!harness) {
          // A typo'd harness name is a config error, and it names itself.
          // Failing the run beats silently skipping the Station and reporting
          // success.
          status = "failed";
          error = `Station "${station.id}" uses harness "${station.harness}", which is not registered.`;
          emitError(ctx, error);
          break;
        }

        const outcome = await runStation(ctx, harness, station, env);
        lastResult = outcome.result;
        addCost(cost, outcome.result.cost);

        if (outcome.status !== "done") {
          status = outcome.status;
          error = outcome.result.error ?? outcome.error;
          break;
        }
      }
    } catch (failure) {
      thrown = failure;
    }

    // The run-level diff, computed once over the run's workspace after every
    // Station has finished. A harness may also return one — the README's
    // example does — but with several Stations each would report only its own
    // slice, and what a reviewer needs is the diff of the whole run.
    //
    // Computed before the failure throw below, deliberately: a run that failed
    // halfway usually did write something first, and that partial work is the
    // most useful thing on the page when you are working out what went wrong.
    const diff = await runDiff(ctx, stations, lastResult, env);
    if (diff) ctx.recordDiff(diff.patch);

    // Re-thrown unchanged so the queue's `isAbort` still sees an `AbortError`
    // and lands the run as `stopped` rather than `failed`.
    if (thrown !== null) throw thrown;

    // A failure is *thrown* rather than returned, because `RunResultSummary`
    // has nowhere to put the reason — the queue reads `error` off a thrown
    // value and writes it onto the Run record. Returning `{ status: "failed" }`
    // would land a failed run in the list with no explanation.
    if (status === "failed") {
      throw new HarnessRunError(error ?? "The harness reported a failure.");
    }

    return {
      status,
      cost,
      durationMs: Date.now() - started,
      ...(diff && diff.stat.filesChanged > 0 && { diff: diff.stat }),
      ...(lastResult?.verdicts !== undefined && {
        verdicts: lastResult.verdicts,
      }),
    };
  };
}

/** A harness that ended a run badly, with the reason it gave. */
export class HarnessRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessRunError";
  }
}

interface StationOutcome {
  status: RunStatus;
  result: RunResult;
  error?: string;
}

async function runStation(
  ctx: ExecutionContext,
  harness: Harness,
  station: Station,
  env: HostEnv,
): Promise<StationOutcome> {
  // Stamped centrally: a harness emits `{ t: "text", chunk }` and cannot
  // misattribute it to another run or another Station.
  const emit = (event: HarnessEvent): void => {
    ctx.emit({
      ...event,
      at: new Date().toISOString(),
      runId: ctx.run.id,
      stationId: station.id,
    } as RunEvent);
  };

  const workspace = createWorkspace({
    station,
    env,
    emit,
    signal: ctx.signal,
  });
  const meter = createMeter({ emit });

  const result = await harness.run({
    runId: ctx.run.id,
    stationId: station.id,
    station,
    brief: ctx.run.prompt,
    workspace,
    emit,
    meter,
    ask: (ask: string, kind: "permission" | "hold" = "permission") =>
      ctx.ask({ ask, kind, stationId: station.id }),
    signal: ctx.signal,
  });

  // A harness that streams cost but returns none is not reporting zero spend;
  // the meter watched it happen. Same asymmetry as the queue's `reconcileCost`
  // and for the same reason — under-counting is the direction that lets
  // someone blow past a cap.
  const settled: RunResult = {
    ...result,
    cost: result.cost ?? meter.total(),
  };

  return {
    status: settled.status ?? "done",
    result: settled,
    ...(settled.error !== undefined && { error: settled.error }),
  };
}

/**
 * The diff for the whole run.
 *
 * Prefers a fresh `git diff` over the run's workspace. Falls back to whatever
 * the last Station's harness returned, which is what covers a harness whose
 * workspace is somewhere the run record does not name.
 */
async function runDiff(
  ctx: ExecutionContext,
  stations: readonly Station[],
  lastResult: RunResult | undefined,
  env: HostEnv,
): Promise<{
  patch: string;
  stat: NonNullable<RunResultSummary["diff"]>;
} | null> {
  const workspace =
    ctx.run.workspace ||
    stations.find((station) => station.workspace)?.workspace;
  if (workspace) {
    const resolved = expandHome(workspace, env);
    // No `signal` here on purpose. The run may have been *stopped*, and a
    // stopped run's partial diff is exactly what the operator wants to see;
    // passing the aborted signal through would kill `git diff` and discard it.
    //
    // The budget is much shorter once the run is aborted, though. `shutdown()`
    // awaits the executor, so on quit these git calls sit directly in the exit
    // path — a 60s budget there is how Step 23's "clean shutdown" becomes a
    // three-minute hang. A stopped run gets a best-effort diff, not a patient
    // one.
    const diff = await diffWorkspace({
      cwd: resolved,
      timeoutMs: ctx.signal.aborted ? 10_000 : 60_000,
    }).catch(() => null);
    if (diff && (diff.patch !== "" || diff.stat.filesChanged > 0)) return diff;
  }
  if (lastResult?.diff) return lastResult.diff;
  return null;
}

/**
 * Which Stations a run touches, in cue order.
 *
 * Ids that match nothing are dropped rather than failing the run: a cuesheet
 * referencing a Station the user has since deleted should still run its other
 * steps, and the config loader already warns about the dangling reference.
 */
function resolveStations(
  loaded: LoadedConfig,
  stationIds: readonly string[],
): Station[] {
  const byId = new Map(
    loaded.config.station.map((station) => [station.id, station] as const),
  );
  const resolved: Station[] = [];
  for (const id of stationIds) {
    const station = byId.get(id);
    if (station) resolved.push(station);
  }
  return resolved;
}

function addCost(total: Cost, delta: Cost | undefined): void {
  if (!delta) return;
  total.tokensIn += delta.tokensIn;
  total.tokensOut += delta.tokensOut;
  if (delta.usd !== undefined) total.usd = (total.usd ?? 0) + delta.usd;
}

function emitError(ctx: ExecutionContext, message: string): void {
  ctx.emit({
    t: "error",
    at: new Date().toISOString(),
    runId: ctx.run.id,
    message,
  });
}
