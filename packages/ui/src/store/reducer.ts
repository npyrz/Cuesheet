/**
 * The Desk's whole state, as one pure reducer over `RunEvent`s.
 *
 * Pure and in its own file for two reasons. It is the piece that is genuinely
 * hard to get right — the reconnect path below is subtle — and it is the piece
 * that can be tested exhaustively without a DOM, a daemon, or a browser. Every
 * component underneath is a rendering of this state and nothing more.
 *
 * ## The reconnect contract
 *
 * The daemon's bus replays a buffer on connect, so a client that joins
 * mid-run sees history. A daemon *restart* empties that buffer, which is
 * exactly the case Step 18's done-when tests, so the UI cannot trust it.
 *
 * The resync is therefore: attach the socket first and **buffer** what
 * arrives, then fetch `/runs`, then `snapshot` (which *replaces*, never
 * merges), then flush the buffer on top. Fetching before attaching loses
 * events in the window between the two; attaching without buffering loses
 * them in the other window. `RunEvent`s carry no unique id, so de-duplication
 * is not available — ordering is the entire defense, which is why `snapshot`
 * replaces and why the caller must flush in arrival order.
 */
import type {
  Cost,
  Run,
  RunEvent,
  RunId,
  RunStatus,
  Standby,
} from "@cuesheet/core";
import { isTerminalStatus } from "@cuesheet/core/types";
import type { RunDetail, StationsResponse } from "../api/client.js";

export type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * What a tile shows, distinct from the Station's *configuration*.
 *
 * Config is what you wrote; this is what is happening right now. Keyed by
 * station id and rebuilt from events, so a Station configured but never run
 * simply has no entry and renders idle.
 */
export interface StationActivity {
  runId: RunId;
  status: "working" | "standby" | "idle" | "failed";
  /** The file the agent most recently touched — the tile's middle line. */
  currentFile?: string;
  /** Last prose the agent emitted, for the tile's activity line. */
  lastText?: string;
  startedAt: string;
  endedAt?: string;
  cost: Cost;
}

export interface DeskState {
  connection: ConnectionStatus;
  /** `null` until the first `/stations` fetch lands. */
  stations: StationsResponse | null;
  /** Newest first, matching `GET /runs`. */
  runs: Run[];
  /** The run the log pane is showing. */
  selectedRunId: RunId | null;
  /** Events per run, for runs this session has seen or opened. */
  events: Record<RunId, RunEvent[]>;
  stationActivity: Record<string, StationActivity>;
  /** Unanswered standbys, newest last. */
  standbys: Standby[];
  /** Last thing that went wrong, shown in the header. */
  error: string | null;
}

export const initialState: DeskState = {
  connection: "connecting",
  stations: null,
  runs: [],
  selectedRunId: null,
  events: {},
  stationActivity: {},
  standbys: [],
  error: null,
};

export type DeskAction =
  | { type: "connection"; status: ConnectionStatus }
  | { type: "stations"; stations: StationsResponse }
  /** Replaces the run list wholesale. The reconnect path depends on this. */
  | { type: "snapshot"; runs: Run[] }
  /** A full `GET /runs/:id`, which replaces that run's events. */
  | { type: "run-detail"; detail: RunDetail }
  | { type: "event"; event: RunEvent }
  | { type: "select"; runId: RunId | null }
  | { type: "error"; message: string | null };

const ZERO_COST: Cost = { tokensIn: 0, tokensOut: 0 };

export function deskReducer(state: DeskState, action: DeskAction): DeskState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.status };

    case "stations":
      return { ...state, stations: action.stations };

    case "snapshot": {
      const runs = action.runs;
      // Events for runs that no longer exist are dropped: a run record deleted
      // off disk should not keep a log pane alive.
      const known = new Set(runs.map((run) => run.id));
      const events = Object.fromEntries(
        Object.entries(state.events).filter(([id]) => known.has(id)),
      );
      // Keep the user's selection if it survived; otherwise fall to the
      // newest run, so the log pane is never pointlessly empty.
      const selectedRunId =
        state.selectedRunId !== null && known.has(state.selectedRunId)
          ? state.selectedRunId
          : (runs[0]?.id ?? null);

      // Station activity is rebuilt from the snapshot rather than carried
      // over: a tile still claiming to be working on a run the daemon has
      // since finished is the exact lie a resync exists to correct.
      const stationActivity = activityFromRuns(runs);

      // And the same argument for standbys, which are the louder lie: a
      // question with **go** and **no** buttons, for a run that ended while
      // the app was not running. The daemon's status is the authority —
      // a standby is open only while its run is waiting on one.
      const standbys = state.standbys.filter(
        (open) =>
          runs.find((run) => run.id === open.runId)?.status === "standby",
      );

      return {
        ...state,
        runs,
        events,
        selectedRunId,
        stationActivity,
        standbys,
      };
    }

    case "run-detail": {
      const { run, events } = action.detail;
      const next: DeskState = {
        ...state,
        runs: upsertRun(state.runs, run),
        events: { ...state.events, [run.id]: events },
      };
      // Replay the fetched log through the same folding the live path uses,
      // so an opened *live* run populates tiles identically — but through
      // `foldEvent`, not `applyEvent`: the events are already in place, and
      // re-appending them would double the log every time a run is opened.
      //
      // A run that has already ended is never replayed. Its record is the
      // authority on everything folding would produce, and folding it anyway
      // is how opening a finished run re-opens a standby nobody can answer,
      // re-lights a tile for work that stopped, and adds its `cost` events on
      // top of the total already in the record. Found by force-quitting the
      // app mid-standby and relaunching: the run was correctly `interrupted`
      // on disk and the Desk showed it waiting for an answer.
      if (isTerminalStatus(run.status)) return next;
      return events.reduce(foldEvent, next);
    }

    case "event":
      return applyEvent(state, action.event);

    case "select":
      return { ...state, selectedRunId: action.runId };

    case "error":
      return { ...state, error: action.message };
  }
}

// ── Event folding ───────────────────────────────────────────────────────────

/**
 * A live event: record it in the log, then fold its meaning into the state.
 *
 * The two halves are separate because `run-detail` needs only the second —
 * it has just replaced the log wholesale and must not append to it again.
 */
function applyEvent(state: DeskState, event: RunEvent): DeskState {
  return foldEvent(
    {
      ...state,
      events: {
        ...state.events,
        [event.runId]: [...(state.events[event.runId] ?? []), event],
      },
    },
    event,
  );
}

/** What an event *means*, with the log left alone. */
function foldEvent(state: DeskState, event: RunEvent): DeskState {
  let next: DeskState = state;

  switch (event.t) {
    case "status": {
      next = patchRun(next, event.runId, (run) => ({
        ...run,
        status: event.status,
        ...(event.status === "running" &&
          run.startedAt === undefined && { startedAt: event.at }),
      }));
      // Leaving `standby` closes the question, whatever it left for. Nothing
      // else ever removed one: an answered standby's buttons stayed on screen
      // until the next reload, and a run stopped while waiting kept asking
      // forever.
      if (event.status !== "standby") {
        next = closeStandbys(next, event.runId);
      }

      // A run entering a terminal state releases every tile it held, whether
      // or not a `done` event follows — `stopped` and `interrupted` arrive as
      // a bare status change.
      if (isTerminalStatus(event.status)) {
        next = releaseStations(next, event.runId, event.at, event.status);
      }
      // Selecting the newest run automatically is what makes "type a prompt
      // and watch it" work without a click.
      if (event.status === "running") {
        next = { ...next, selectedRunId: event.runId };
      }
      return next;
    }

    case "text":
      return touchStation(next, event, (activity) => {
        // A whitespace-only chunk keeps the previous line rather than
        // blanking the tile. `exactOptionalPropertyTypes` is on, so an absent
        // `lastText` has to stay absent rather than become `undefined`.
        const chunk = event.chunk.trim();
        const lastText = chunk !== "" ? chunk : activity.lastText;
        return {
          ...activity,
          status: "working",
          ...(lastText !== undefined && { lastText }),
        };
      });

    case "tool":
      return touchStation(next, event, (activity) => ({
        ...activity,
        status: "working",
      }));

    case "file":
      return touchStation(next, event, (activity) => ({
        ...activity,
        status: "working",
        currentFile: event.path,
      }));

    case "cost": {
      const withStation = touchStation(next, event, (activity) => ({
        ...activity,
        cost: addCost(activity.cost, event),
      }));
      // Run totals accumulate independently of tiles: a run with no station
      // events still has to show a bill.
      return patchRun(withStation, event.runId, (run) => ({
        ...run,
        cost: addCost(run.cost, event),
      }));
    }

    case "standby": {
      // A late standby for a run that has already ended opens a question with
      // nothing behind it: the registry that would answer it is gone.
      const current = next.runs.find((run) => run.id === event.runId);
      if (current !== undefined && isTerminalStatus(current.status)) {
        return next;
      }

      const standby: Standby = {
        id: event.standbyId,
        runId: event.runId,
        ask: event.ask,
        kind: "permission",
        at: event.at,
      };
      const withStandby: DeskState = {
        ...next,
        standbys: [
          ...next.standbys.filter((open) => open.id !== standby.id),
          standby,
        ],
      };
      return markStations(withStandby, event.runId, (activity) => ({
        ...activity,
        status: "standby",
      }));
    }

    case "denial":
      // A denial is not a failure — the leash stopped something and the run
      // continues. It belongs in the log, which `events` already has.
      return next;

    case "done": {
      next = closeStandbys(next, event.runId);
      const finished = patchRun(next, event.runId, (run) => ({
        ...run,
        status: event.result.status,
        finishedAt: event.at,
        result: event.result,
        cost: event.result.cost,
      }));
      return releaseStations(
        finished,
        event.runId,
        event.at,
        event.result.status,
      );
    }

    case "error": {
      const failed = patchRun(next, event.runId, (run) => ({
        ...run,
        error: event.message,
      }));
      return { ...failed, error: event.message };
    }
  }
}

/**
 * Update a run in the list, inserting a placeholder if it is unknown.
 *
 * The insert arm is not defensive padding: a run started from another client —
 * the CLI, or the phone in M3 — arrives here as events for a run this Desk has
 * never fetched, and dropping those events would make the tiles animate for a
 * run that never appears in the list.
 */
function patchRun(
  state: DeskState,
  runId: RunId,
  apply: (run: Run) => Run,
): DeskState {
  const index = state.runs.findIndex((run) => run.id === runId);
  if (index === -1) {
    const placeholder: Run = {
      id: runId,
      kind: "prompt",
      status: "running",
      prompt: "",
      stationIds: [],
      workspace: "",
      createdAt: new Date().toISOString(),
      cost: { ...ZERO_COST },
    };
    // Run ids are timestamp-prefixed, so newest-first is a reverse sort.
    return {
      ...state,
      runs: [apply(placeholder), ...state.runs].sort((a, b) =>
        b.id.localeCompare(a.id),
      ),
    };
  }
  const runs = [...state.runs];
  runs[index] = apply(runs[index] as Run);
  return { ...state, runs };
}

function upsertRun(runs: Run[], run: Run): Run[] {
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index === -1)
    return [run, ...runs].sort((a, b) => b.id.localeCompare(a.id));
  const next = [...runs];
  next[index] = run;
  return next;
}

/** Events that name a Station. The others cannot move a tile. */
type StationEvent = Extract<RunEvent, { stationId: string }>;

function touchStation(
  state: DeskState,
  event: StationEvent,
  apply: (activity: StationActivity) => StationActivity,
): DeskState {
  const existing = state.stationActivity[event.stationId];
  const base: StationActivity = existing ?? {
    runId: event.runId,
    status: "working",
    startedAt: event.at,
    cost: { ...ZERO_COST },
  };
  // A Station picked up by a *newer* run starts fresh: carrying the previous
  // run's file and cost into a new run's tile misreports both.
  const activity =
    existing && existing.runId !== event.runId
      ? {
          runId: event.runId,
          status: "working" as const,
          startedAt: event.at,
          cost: { ...ZERO_COST },
        }
      : base;

  return {
    ...state,
    stationActivity: {
      ...state.stationActivity,
      [event.stationId]: apply(activity),
    },
  };
}

function markStations(
  state: DeskState,
  runId: RunId,
  apply: (activity: StationActivity) => StationActivity,
): DeskState {
  const entries = Object.entries(state.stationActivity).map(([id, activity]) =>
    activity.runId === runId
      ? ([id, apply(activity)] as const)
      : ([id, activity] as const),
  );
  return { ...state, stationActivity: Object.fromEntries(entries) };
}

function releaseStations(
  state: DeskState,
  runId: RunId,
  at: string,
  status: RunStatus,
): DeskState {
  return markStations(state, runId, (activity) => ({
    ...activity,
    status: status === "failed" ? "failed" : "idle",
    endedAt: at,
  }));
}

/**
 * Rebuild tile state from run records alone, for the resync path.
 *
 * Only non-terminal runs can hold a Station, so this is mostly a way of
 * *clearing* stale activity. A run still `running` after a reconnect keeps its
 * tiles lit, but without a current file until the next event says otherwise —
 * claiming the last file we happened to see would be inventing state.
 */
/** Every open question belonging to one run, closed. */
function closeStandbys(state: DeskState, runId: string): DeskState {
  if (!state.standbys.some((open) => open.runId === runId)) return state;
  return {
    ...state,
    standbys: state.standbys.filter((open) => open.runId !== runId),
  };
}

function activityFromRuns(runs: Run[]): Record<string, StationActivity> {
  const activity: Record<string, StationActivity> = {};
  // Oldest first, so a Station claimed by two runs ends up owned by the newer.
  for (const run of [...runs].reverse()) {
    if (isTerminalStatus(run.status)) continue;
    for (const stationId of run.stationIds) {
      activity[stationId] = {
        runId: run.id,
        status: run.status === "standby" ? "standby" : "working",
        startedAt: run.startedAt ?? run.createdAt,
        cost: run.cost,
      };
    }
  }
  return activity;
}

function addCost(
  cost: Cost,
  event: { tokensIn: number; tokensOut: number; usd?: number },
): Cost {
  const usd =
    event.usd === undefined && cost.usd === undefined
      ? undefined
      : (cost.usd ?? 0) + (event.usd ?? 0);
  return {
    tokensIn: cost.tokensIn + event.tokensIn,
    tokensOut: cost.tokensOut + event.tokensOut,
    ...(usd !== undefined && { usd }),
  };
}

// ── Selectors ───────────────────────────────────────────────────────────────

export function selectedRun(state: DeskState): Run | null {
  if (state.selectedRunId === null) return null;
  return state.runs.find((run) => run.id === state.selectedRunId) ?? null;
}

export function selectedEvents(state: DeskState): RunEvent[] {
  if (state.selectedRunId === null) return [];
  return state.events[state.selectedRunId] ?? [];
}

/** The run the tiles are animating, if any. */
export function activeRun(state: DeskState): Run | null {
  return state.runs.find((run) => !isTerminalStatus(run.status)) ?? null;
}
