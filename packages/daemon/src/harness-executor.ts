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
  describeGate,
  evaluateGate,
  expandHome,
  hostEnv,
  isGateRef,
  parseVerdict,
  REVIEW_INSTRUCTIONS,
  type Cost,
  type DiffStat,
  type GateParticipant,
  type GateReport,
  type HostEnv,
  type LoadedConfig,
  type RunEvent,
  type RunResultSummary,
  type RunStatus,
  type Station,
  type Verdict,
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
    const steps = planSteps(loaded, ctx.run);
    const stations = steps
      .filter((step) => step.kind === "station")
      .map((step) => step.station);

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

    // What the Gates will read. `participants` is every Station that actually
    // acted — author included — because `distinct_vendors` counts who did the
    // work and who checked it, not who filed a verdict.
    const verdicts: Verdict[] = [];
    const participants: GateParticipant[] = [];
    const gates: GateReport[] = [];

    // The loop is wrapped rather than left to reject, because the two shipped
    // harnesses disagree about how a stop arrives: `claude-code` returns
    // `{ status: "stopped" }` while a harness awaiting its own timers throws an
    // `AbortError`. Both must still get their diff recorded below — a stopped
    // run's partial work is the most useful thing on the page — so the throw is
    // caught here and re-thrown after, unchanged.
    let thrown: unknown = null;
    try {
      for (const step of steps) {
        if (ctx.signal.aborted) {
          status = "stopped";
          break;
        }

        if (step.kind === "gate") {
          const gate = loaded.config.gate[step.name];
          if (gate === undefined) {
            // A cue naming a gate that does not exist must never read as
            // satisfied. The config loader warns about this; here it stops
            // the run, because "the check did not run" and "the check passed"
            // have to look different.
            status = "failed";
            error = `This cuesheet references gate "${step.name}", which is not configured. Add a [gate.${step.name}] table.`;
            emitError(ctx, error);
            break;
          }

          // The diff *at this cue*, not the run's final one: a gate placed
          // mid-cuesheet has to judge what exists when it runs, and
          // `skip_if_diff_under` is meaningless against a diff computed after
          // every Station has finished.
          const diff = await gateDiff(ctx, stations, env);
          const result = evaluateGate(gate, {
            verdicts,
            participants,
            ...(diff !== undefined && { diff }),
          });

          if (result.outcome !== "hold") {
            gates.push({
              gate: step.name,
              outcome: result.outcome,
              reasons: result.reasons,
            });
            continue;
          }

          // A held run asks before it stops. This is the README's "lands as a
          // standby on whatever device you are holding" — and it is the
          // existing standby machinery, so it already notifies, already shows
          // go/no in the Desk, and already reaches the phone in M3.
          const answer = await ctx.ask({
            ask: `${describeGate(step.name, result)} Override and continue?`,
            kind: "hold",
          });

          gates.push({
            gate: step.name,
            outcome: result.outcome,
            reasons: result.reasons,
            ...(answer === "go" && { overridden: true }),
          });

          if (answer === "no") {
            status = "held";
            error = describeGate(step.name, result);
            break;
          }
          continue;
        }

        const station = step.station;
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

        const reviewing = station.role === "reviewer";
        const brief = reviewing
          ? await reviewBrief(ctx, stations, env)
          : ctx.run.prompt;

        const outcome = await runStation(ctx, harness, station, env, brief);
        lastResult = outcome.result;
        addCost(cost, outcome.result.cost);
        participants.push({
          stationId: station.id,
          harness: harness.id,
          vendor: harness.vendor,
        });

        if (reviewing) {
          for (const verdict of collectVerdicts(
            ctx,
            station,
            harness,
            outcome,
          )) {
            verdicts.push(verdict);
            ctx.emit({
              t: "verdict",
              at: verdict.at,
              runId: ctx.run.id,
              stationId: station.id,
              verdict,
            });
          }
        }

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

    // A Hold is *returned*, not thrown. The queue reads `summary.status`, and
    // a held run's whole value is the record it leaves behind — the verdicts,
    // the findings, and the gate's reasons. Throwing would land it as `failed`
    // with a message and none of that.
    return {
      status,
      cost,
      durationMs: Date.now() - started,
      ...(diff && diff.stat.filesChanged > 0 && { diff: diff.stat }),
      ...(verdicts.length > 0
        ? { verdicts }
        : lastResult?.verdicts !== undefined && {
            verdicts: lastResult.verdicts,
          }),
      ...(gates.length > 0 && { gates }),
      // A Hold's reason. `failed` throws instead, and the queue reads that
      // message off the thrown value.
      ...(status === "held" && error !== undefined && { error }),
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
  /** Everything the Station streamed as text, for reading a verdict out of. */
  transcript: string;
  error?: string;
}

async function runStation(
  ctx: ExecutionContext,
  harness: Harness,
  station: Station,
  env: HostEnv,
  brief: string,
): Promise<StationOutcome> {
  // Stamped centrally: a harness emits `{ t: "text", chunk }` and cannot
  // misattribute it to another run or another Station.
  // A reviewer's verdict usually arrives as prose, so this Station's text is
  // accumulated as it streams. Capped, because a chatty reviewer should not be
  // able to grow the executor's memory without bound — and a verdict that is
  // not in the first megabyte is not going to be found by scrolling further.
  let transcript = "";
  const emit = (event: HarnessEvent): void => {
    if (event.t === "text" && transcript.length < TRANSCRIPT_LIMIT) {
      transcript += event.chunk;
    }
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
    brief,
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
    transcript,
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

/** How much of a Station's text to keep for verdict parsing. */
const TRANSCRIPT_LIMIT = 1_000_000;

/**
 * How much diff to show a reviewer before it stops being useful context.
 *
 * This is the knob that decides what a review *costs*: every byte here is
 * input tokens on someone's bill, and a reviewer reading a repo can spend
 * more than the engineer that wrote the change did. 200 KB is roughly a large
 * feature branch — big enough that a real review is never truncated, small
 * enough that a runaway diff (a committed `node_modules`, a lockfile churn)
 * cannot quietly turn one gate into a five-figure token count. Truncation is
 * announced in the brief rather than silent, because a reviewer that saw half
 * the change should say so.
 */
const REVIEW_DIFF_LIMIT = 200_000;

type PlannedStep =
  { kind: "station"; station: Station } | { kind: "gate"; name: string };

/**
 * The run, as an ordered list of things to do.
 *
 * A cuesheet is the authority when the run names one: its cues carry gates,
 * and gates have to execute *between* Stations rather than after them. A run
 * without a cuesheet is the Desk's single-prompt case, and stays exactly what
 * it was — a list of Stations in order.
 *
 * Cues naming a Station that no longer exists are dropped rather than failing
 * the run; the config loader already warns, and a deleted Station should not
 * cost you the other steps. A *gate* cue is never dropped, because silently
 * skipping a safety check is the one thing this design cannot do.
 */
function planSteps(
  loaded: LoadedConfig,
  run: { cuesheetId?: string; stationIds: readonly string[] },
): PlannedStep[] {
  const byId = new Map(
    loaded.config.station.map((station) => [station.id, station] as const),
  );

  const sheet =
    run.cuesheetId === undefined
      ? undefined
      : loaded.config.cuesheet[run.cuesheetId];

  if (sheet !== undefined) {
    const steps: PlannedStep[] = [];
    for (const cue of sheet.cues) {
      if (isGateRef(cue)) {
        steps.push({ kind: "gate", name: cue.gate });
        continue;
      }
      const station = byId.get(cue.station);
      if (station) steps.push({ kind: "station", station });
    }
    return steps;
  }

  return resolveStations(loaded, run.stationIds).map((station) => ({
    kind: "station" as const,
    station,
  }));
}

/**
 * What a reviewer is actually asked.
 *
 * Without this a Station with `role = "reviewer"` just does the original task
 * again with a different model — which looks like a review, costs like a
 * review, and checks nothing. The brief is the original ask, the diff as it
 * stands, and the format the verdict parser reads.
 */
async function reviewBrief(
  ctx: ExecutionContext,
  stations: readonly Station[],
  env: HostEnv,
): Promise<string> {
  const diff = await workspaceDiff(ctx, stations, env);
  const patch = diff?.patch ?? "";
  const shown =
    patch.length > REVIEW_DIFF_LIMIT
      ? `${patch.slice(0, REVIEW_DIFF_LIMIT)}\n… diff truncated at ${REVIEW_DIFF_LIMIT} characters …`
      : patch;

  return [
    "You are reviewing another agent's work. Do not change any files.",
    "",
    `The brief they were given:\n${ctx.run.prompt}`,
    "",
    shown.trim() === ""
      ? "They changed nothing. That is itself worth a verdict."
      : `What they changed:\n\n\`\`\`diff\n${shown}\n\`\`\``,
    "",
    REVIEW_INSTRUCTIONS,
  ].join("\n");
}

/**
 * A reviewer's verdicts: whatever the harness reported, or whatever can be
 * read out of what it said.
 *
 * A harness that understands verdicts returns them directly — that is what
 * `RunResult.verdicts` is for. Everything else is a CLI that streamed prose,
 * and `parseVerdict` abstains when it cannot find a decision in it. An
 * abstention is not an approval, which is what stops a crashed or rambling
 * reviewer from satisfying a gate.
 */
function collectVerdicts(
  ctx: ExecutionContext,
  station: Station,
  harness: Harness,
  outcome: StationOutcome,
): Verdict[] {
  const at = new Date().toISOString();
  const reported = outcome.result.verdicts;
  if (reported !== undefined && reported.length > 0) {
    return reported.map((verdict, index) => ({
      ...verdict,
      id: verdict.id || `${ctx.run.id}-${station.id}-${index}`,
      runId: ctx.run.id,
      stationId: station.id,
      harness: harness.id,
      vendor: harness.vendor,
      at: verdict.at || at,
    }));
  }

  const parsed = parseVerdict(outcome.transcript);
  return [
    {
      id: `${ctx.run.id}-${station.id}-0`,
      runId: ctx.run.id,
      stationId: station.id,
      harness: harness.id,
      vendor: harness.vendor,
      decision: parsed.decision,
      findings: parsed.findings,
      at,
    },
  ];
}

/** The workspace diff right now, or `undefined` if there is no reading it. */
async function workspaceDiff(
  ctx: ExecutionContext,
  stations: readonly Station[],
  env: HostEnv,
): Promise<{ patch: string; stat: DiffStat } | undefined> {
  const workspace =
    ctx.run.workspace ||
    stations.find((station) => station.workspace)?.workspace;
  if (!workspace) return undefined;
  const diff = await diffWorkspace({
    cwd: expandHome(workspace, env),
    timeoutMs: ctx.signal.aborted ? 10_000 : 60_000,
  }).catch(() => null);
  return diff ?? undefined;
}

/**
 * The diff a Gate judges.
 *
 * `undefined` when it cannot be read, and `evaluateGate` treats that as "not
 * known" rather than "small" — a failed `git diff` must not turn
 * `skip_if_diff_under` into a gate that silently never runs.
 */
async function gateDiff(
  ctx: ExecutionContext,
  stations: readonly Station[],
  env: HostEnv,
): Promise<DiffStat | undefined> {
  return (await workspaceDiff(ctx, stations, env))?.stat;
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
