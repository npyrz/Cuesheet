/**
 * Wiring: the socket, the HTTP client, and the reducer, joined.
 *
 * The one piece of real logic here is the resync, and it is written out
 * step-by-step in {@link resync} because the ordering is the entire
 * correctness argument — see the header comment in `reducer.ts`.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ListedProject, RunEvent, RunId } from "@cuesheet/core";
import {
  addStation,
  answerStandby,
  fetchDiff,
  fetchProjects,
  openProject,
  fetchRun,
  fetchRuns,
  fetchStations,
  fetchUsage,
  startRun,
  stopRun,
  type NewStation,
} from "../api/client.js";
import { connectEvents } from "../api/socket.js";
import { deskReducer, initialState, type DeskState } from "./reducer.js";

/** How many runs the list pane holds. Plenty for a session; not unbounded. */
const RUN_LIMIT = 50;

/**
 * How often the strip re-asks.
 *
 * Matched to the daemon's own usage TTL rather than chosen independently:
 * polling faster would return the same cached answer, and polling slower would
 * leave the strip behind a reading the daemon already has. The daemon drops
 * its cache when a run finishes, which is the moment the number actually
 * moves, so this interval is only catching drift between runs.
 */
const USAGE_POLL_MS = 30_000;

/**
 * Which project the Desk is showing, and how it got there.
 *
 * `loading` is a real state rather than a null check: the first paint happens
 * before `GET /projects` answers, and rendering "no projects" for a frame and
 * then a full Desk is worse than rendering nothing for that frame.
 *
 * Step 34 adds switching; Steps 40 and 41 give it a designed surface. What
 * lives here is the mechanism — resolve a project, attach to it, and move to
 * another one without disturbing what the first one is doing.
 */
export type ProjectState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "open"; project: ListedProject };

export interface DeskApi {
  state: DeskState;
  project: ProjectState;
  /** Every project the daemon knows, newest-opened first. */
  projects: ListedProject[];
  /** Open a folder as a project and show it. Step 40 gives this a real surface. */
  openFolder(root: string): Promise<void>;
  /** Show a project the daemon already knows. See {@link switchTo}. */
  switchTo(id: string): Promise<void>;
  start(prompt: string, cuesheet?: string): Promise<void>;
  stop(runId: RunId): Promise<void>;
  select(runId: RunId): Promise<void>;
  answer(standbyId: string, answer: "go" | "no"): Promise<void>;
  create(draft: NewStation): Promise<void>;
  diff(runId: RunId): Promise<string | null>;
  dismissError(): void;
}

export function useDesk(): DeskApi {
  const [state, dispatch] = useReducer(deskReducer, initialState);
  const [project, setProject] = useState<ProjectState>({ status: "loading" });
  /** Everything the daemon knows, for the switcher. Refreshed on every switch. */
  const [projects, setProjects] = useState<ListedProject[]>([]);

  /**
   * The project every call below is scoped to.
   *
   * `GET /projects` answers most-recently-opened first, so the head of the
   * list is the one to reopen — the same answer the registry's `lastOpened`
   * gives, without a second route to keep in step with it.
   */
  useEffect(() => {
    let cancelled = false;
    void fetchProjects()
      .then((listed) => {
        if (cancelled) return;
        setProjects(listed);
        const usable = listed.find((p) => p.status === "ok");
        setProject(
          usable ? { status: "open", project: usable } : { status: "none" },
        );
      })
      .catch(() => {
        // A daemon that is not up yet is not "no projects" — the socket's
        // reconnect is what recovers, and claiming a first-run state here
        // would tell the user to pick a folder they have already picked.
        if (!cancelled) setProject({ status: "loading" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const projectId = project.status === "open" ? project.project.id : null;

  /**
   * Events that arrived while a resync was in flight.
   *
   * A ref rather than state: this must be written from a socket callback
   * without re-rendering, and read synchronously at the end of the resync.
   */
  const buffer = useRef<RunEvent[]>([]);
  const resyncing = useRef(false);

  /**
   * Which project's resync is allowed to finish.
   *
   * Step 34, and the one real bug switching introduced. A resync is several
   * awaits long and nothing could cancel it: switch from A to B while A's
   * fetches are in flight and A's socket closes, B's opens and starts its own
   * resync — then A's settles and dispatches `snapshot` with **A's runs**,
   * clears `resyncing`, and flushes the buffer array it captured into B. The
   * Desk lands on B showing A's runs, with B's live events discarded into a
   * buffer nobody will read.
   *
   * Every resync takes a token on the way in and checks it before each group
   * of dispatches. The socket effect bumps the epoch on teardown too, so a
   * stale resync is invalidated at the moment of the switch rather than when
   * the next one happens to start.
   */
  const epoch = useRef(0);

  /**
   * The current selection, readable from inside `resync` without making it
   * depend on state (which would rebuild the socket effect on every click).
   */
  const selected = useRef<RunId | null>(null);
  useEffect(() => {
    selected.current = state.selectedRunId;
  }, [state.selectedRunId]);

  /**
   * Run ids this session has a real record for.
   *
   * The reducer invents a placeholder when events arrive for a run it has
   * never seen — which is right, because dropping those events would animate
   * tiles for a run that never appears in the list. But a placeholder has no
   * prompt, so the row and the log header read "(no prompt)" until something
   * fetches the real thing. Nothing did.
   *
   * This is not only the run *you* just started: a run kicked off from the
   * CLI, or from the phone in M3, reaches this Desk the same way.
   */
  const known = useRef<Set<RunId>>(new Set());
  useEffect(() => {
    known.current = new Set(state.runs.map((run) => run.id));
  }, [state.runs]);
  /** Ids already being fetched, so a burst of events triggers one request. */
  const fetching = useRef<Set<RunId>>(new Set());

  const fail = useCallback((error: unknown) => {
    dispatch({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }, []);

  const resync = useCallback(
    async (id: string) => {
      // 0. Claim this resync. Anything that bumps the epoch after this line —
      //    a switch, a teardown — makes everything below a no-op.
      const token = (epoch.current += 1);
      const current = (): boolean => epoch.current === token;
      // 1. Start buffering. The socket is already attached by the time `onOpen`
      //    calls this, so from here nothing can be missed.
      resyncing.current = true;
      buffer.current = [];
      try {
        // 2. Fetch the authoritative list and the Station config.
        const [runs, stations] = await Promise.all([
          fetchRuns(id, RUN_LIMIT),
          fetchStations(id),
        ]);
        // Usage is fetched but *not* awaited alongside those two. It is a
        // global route with nothing project-scoped about it, and a vendor CLI
        // that is slow to answer must not hold up the tiles and the run list.
        void fetchUsage()
          .then((usage) => {
            if (current()) dispatch({ type: "usage", usage: usage.harnesses });
          })
          .catch(() => {
            // A strip that cannot be read is a strip that is not drawn. It is
            // never worth the error banner that belongs to the work.
          });
        // 3. Replace. Anything the UI believed that the daemon does not is now
        //    gone, which is the point of a resync — but only if this is still
        //    the project the Desk is on. `snapshot` replaces wholesale, so a
        //    late one from the project you left is the most destructive thing
        //    that could land here.
        if (!current()) return;
        dispatch({ type: "snapshot", runs });
        dispatch({ type: "stations", stations });
        dispatch({ type: "error", message: null });

        // 3b. Fetch the log for whichever run is now selected.
        //
        //     `snapshot` selects the newest run when nothing survived, but it
        //     cannot invent that run's events — they were never on this
        //     session's socket. Without this the Desk opens on the newest run
        //     and shows "No events." until you click it.
        const target =
          selected.current !== null &&
          runs.some((candidate) => candidate.id === selected.current)
            ? selected.current
            : (runs[0]?.id ?? null);
        if (target !== null) {
          const detail = await fetchRun(id, target);
          if (!current()) return;
          // Before the flush, deliberately: `run-detail` replaces one run's
          // events, so a buffered live event flushed afterwards lands on top
          // rather than being overwritten by a log fetched a moment earlier.
          dispatch({ type: "run-detail", detail });
        }
      } catch (error) {
        // A failure belonging to a project the Desk has already left is not
        // one to show over the project it is on now.
        if (current()) fail(error);
      } finally {
        // 4. Flush what arrived during the fetch, in arrival order, on top of
        //    the snapshot. Events carry no id, so order is the only defense
        //    against double-counting — never sort, never dedupe.
        //
        //    A superseded resync flushes nothing and clears nothing: `buffer`
        //    and `resyncing` now belong to the resync that replaced it, and
        //    taking them would strand the new project's live events.
        if (current()) {
          const pending = buffer.current;
          buffer.current = [];
          resyncing.current = false;
          for (const event of pending) dispatch({ type: "event", event });
        }
      }
    },
    [fail],
  );

  /** Pull the real record for a run we only know as a placeholder. */
  const adopt = useCallback((id: string, runId: RunId) => {
    if (known.current.has(runId) || fetching.current.has(runId)) return;
    fetching.current.add(runId);
    // Marked known immediately: the effect that syncs `known` from state
    // does not run until the next render, and a second event arriving in
    // this same tick would otherwise fire a duplicate fetch.
    known.current.add(runId);
    void fetchRun(id, runId)
      .then((detail) => dispatch({ type: "run-detail", detail }))
      .catch(() => {
        // The run may not be on disk yet; the next event tries again.
        known.current.delete(runId);
      })
      .finally(() => fetching.current.delete(runId));
  }, []);

  // The strip's own clock. Separate from the resync because usage is global:
  // it keeps ticking across a project switch, and it does not need a socket.
  useEffect(() => {
    let live = true;
    const poll = (): void => {
      void fetchUsage()
        .then((usage) => {
          if (live) dispatch({ type: "usage", usage: usage.harnesses });
        })
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, USAGE_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // No project, no socket. Connecting to a project-scoped path without one
    // would fail every reconnect on a schedule.
    if (projectId === null) return;
    // Everything the Desk holds describes the project it was on. Cleared
    // before the socket opens, so the switch never renders one project's
    // tiles, standbys or run list under another's name. See the `project`
    // action in `reducer.ts` for why the standby is the one that would do
    // damage rather than merely mislead.
    dispatch({ type: "project" });
    // These two are caches of state, and the effects that keep them in step
    // do not run until the next render — so after a reset they describe the
    // project just left for one tick. Not a correctness bug on its own: run
    // ids come from one process-wide factory, so two projects cannot mint the
    // same one and a stale entry can never match. Cleared because a cache of
    // something that no longer exists has no reason to survive.
    known.current = new Set();
    fetching.current = new Set();
    const socket = connectEvents(projectId, {
      onEvent(event) {
        if (resyncing.current) buffer.current.push(event);
        else {
          dispatch({ type: "event", event });
          adopt(projectId, event.runId);
        }
      },
      onOpen() {
        dispatch({ type: "connection", status: "open" });
        void resync(projectId);
      },
      onClose() {
        dispatch({ type: "connection", status: "closed" });
      },
    });
    return () => {
      // Bumping the epoch here rather than only in the next `resync` is what
      // makes a teardown cancel in-flight work immediately. Switching away and
      // arriving nowhere — unmount, or a project that fails to resolve — would
      // otherwise leave the old resync free to land whenever it settled.
      epoch.current += 1;
      socket.close();
    };
  }, [projectId, resync, adopt]);

  const start = useCallback(
    async (prompt: string, cuesheet?: string) => {
      if (projectId === null) return;
      try {
        await startRun(projectId, prompt, cuesheet);
        // No optimistic insert: the `status` event that follows carries the
        // real run id, and guessing one would leave a ghost row behind.
      } catch (error) {
        fail(error);
      }
    },
    [projectId, fail],
  );

  const stop = useCallback(
    async (runId: RunId) => {
      if (projectId === null) return;
      try {
        await stopRun(projectId, runId);
      } catch (error) {
        fail(error);
      }
    },
    [projectId, fail],
  );

  const select = useCallback(
    async (runId: RunId) => {
      if (projectId === null) return;
      dispatch({ type: "select", runId });
      try {
        // Always re-fetch: a run opened from the list may predate this
        // session entirely, so its events were never on the socket.
        dispatch({
          type: "run-detail",
          detail: await fetchRun(projectId, runId),
        });
      } catch (error) {
        fail(error);
      }
    },
    [projectId, fail],
  );

  const answer = useCallback(
    async (standbyId: string, value: "go" | "no") => {
      try {
        await answerStandby(standbyId, value);
      } catch (error) {
        fail(error);
      }
    },
    [fail],
  );

  const create = useCallback(
    async (draft: NewStation) => {
      if (projectId === null) throw new Error("No project is open.");
      // Deliberately *not* caught: the Add a Station panel shows the daemon's
      // own message — "a station named opus is already configured" — next to
      // the field that caused it, which a global error banner cannot do.
      const { stations } = await addStation(projectId, draft);
      dispatch({ type: "stations", stations });
    },
    [projectId],
  );

  const diff = useCallback(
    async (runId: RunId) =>
      projectId === null ? null : fetchDiff(projectId, runId),
    [projectId],
  );

  /**
   * Open a folder and switch to it.
   *
   * The minimum that makes the app usable after the route cutover: without it a
   * fresh install shows the "no project" placeholder with no way out, because
   * nothing in the shell could create one. Step 40 replaces this with recents,
   * a missing-folder state and a real picker; Step 34 makes switching between
   * already-open projects a first-class action rather than a side effect of
   * opening one.
   */
  const openFolder = useCallback(
    async (root: string) => {
      try {
        const opened = await openProject(root);
        // Listed rather than raw: the Desk renders `status`, and a folder the
        // daemon just resolved is by definition present.
        setProject({ status: "open", project: { ...opened, status: "ok" } });
        setProjects(await fetchProjects());
      } catch (error) {
        fail(error);
      }
    },
    [fail],
  );

  /**
   * Show a project the daemon already knows — Step 34's whole subject.
   *
   * **A switch is a client action and nothing else.** Everything that makes
   * the project you are leaving keep working is already true of the daemon:
   * its queue, run store and event bus belong to its runtime, not to your
   * socket, and dropping a socket unsubscribes a listener rather than
   * stopping anything. So this changes which project this client is attached
   * to, and deliberately tells the daemon nothing about "the current project"
   * — Phase 8 decided the daemon has no such notion, and two windows on two
   * projects is what that decision is for.
   *
   * **It reuses `POST /projects` rather than adding a route**, because
   * `registry.open` is idempotent by resolved root and updating recency is
   * exactly what it does. That is also what makes "reopen the project you were
   * last in" survive a restart: the daemon and the Desk both read the head of
   * the same recency-ordered list, so there is no second source to keep in
   * step. A project whose folder has gone is refused by the same call, with
   * the registry's own message.
   */
  const switchTo = useCallback(
    async (id: string) => {
      if (id === projectId) return;
      const target = projects.find((candidate) => candidate.id === id);
      if (!target) return;
      try {
        // Before the state change, so a folder that has since disappeared
        // fails here and leaves the Desk where it is, rather than switching to
        // a project whose every request is about to 404.
        const opened = await openProject(target.root);
        setProject({ status: "open", project: { ...opened, status: "ok" } });
        setProjects(await fetchProjects());
      } catch (error) {
        fail(error);
      }
    },
    [projectId, projects, fail],
  );

  const dismissError = useCallback(() => {
    dispatch({ type: "error", message: null });
  }, []);

  return useMemo(
    () => ({
      state,
      project,
      projects,
      openFolder,
      switchTo,
      start,
      stop,
      select,
      answer,
      create,
      diff,
      dismissError,
    }),
    [
      state,
      project,
      projects,
      openFolder,
      switchTo,
      start,
      stop,
      select,
      answer,
      create,
      diff,
      dismissError,
    ],
  );
}
