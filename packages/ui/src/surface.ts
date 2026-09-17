/**
 * The three states every surface has and none of them had all of: nothing
 * yet, nothing to show, and nothing worked.
 *
 * Step 44. Before this, each surface invented its own — and the invention was
 * usually two states doing the work of three. The project view read
 * *"Reading this project's configuration…"* forever when `/stations` failed,
 * because `stations === null` meant both "in flight" and "the fetch threw";
 * the run list read *"No runs yet."* during the first fetch, which is a claim
 * about a project made before anybody asked it anything. A loading state that
 * is really an error, and an empty state that is really a loading state, are
 * the same bug: a surface reporting a fact it does not have.
 *
 * So the decision is made once, here, where a test can reach it — the same
 * division `posture.ts`, `runview.ts` and `limits.ts` already make. The `.tsx`
 * renders what comes back and decides nothing.
 */

/** How the last read of whatever a surface draws went. */
export type Load =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "failed"; error: string };

export const LOADING: Load = { status: "loading" };
export const READY: Load = { status: "ready" };

/** What a given surface calls each of the three. */
export interface SurfaceCopy {
  /** In flight, as a sentence about what is being read. */
  loading: string;
  /** Read, and there is genuinely nothing — the headline. */
  empty: string;
  /** The sentence under it, if the headline is not the whole story. */
  emptyDetail?: string;
  /** The one action that fills it, if there is one. */
  action?: string;
  /** Names what could not be read. The cause is appended, never replaced. */
  failed: string;
}

export interface SurfaceState {
  kind: "loading" | "empty" | "error";
  title: string;
  detail: string | null;
  action: string | null;
  /** Whether trying again is the sensible response. Only ever true on error. */
  retry: boolean;
}

/**
 * Which of the three a surface is in, or `null` for "draw the real thing".
 *
 * `count` is how many rows the surface would draw right now, and it is what
 * separates the interesting cases from the obvious ones:
 *
 * - **Loading beats empty.** A zero you have not finished counting is not a
 *   zero. "No runs yet" during the first fetch is a statement about the
 *   project, made before the project was asked.
 * - **An error beats loading.** A failed fetch that keeps rendering a
 *   progress sentence is the worst of the three, because it never resolves
 *   and the screen keeps promising that it will.
 * - **Neither beats content.** A refresh that fails over a list that is
 *   already on screen leaves the list there. What is drawn is still true —
 *   it just may be a minute old — and blanking it to announce the failure
 *   trades something true for something loud. That is the error *banner's*
 *   job, which the shell already has.
 *
 * The cause is appended to `failed` rather than replacing it, because the two
 * sentences answer different questions: ours says what is missing from this
 * screen, the daemon's says why. `ECONNREFUSED` alone, centred in a pane,
 * tells you neither.
 */
export function describeSurface(
  load: Load,
  count: number,
  copy: SurfaceCopy,
): SurfaceState | null {
  if (count > 0) return null;

  if (load.status === "failed") {
    const cause = load.error.trim();
    return {
      kind: "error",
      title: copy.failed,
      detail: cause === "" ? null : cause,
      action: null,
      retry: true,
    };
  }

  if (load.status === "loading") {
    return {
      kind: "loading",
      title: copy.loading,
      detail: null,
      action: null,
      retry: false,
    };
  }

  return {
    kind: "empty",
    title: copy.empty,
    detail: copy.emptyDetail ?? null,
    action: copy.action ?? null,
    retry: false,
  };
}

/**
 * The copy for every surface in the app, in one place.
 *
 * Together rather than beside each component on purpose. These sentences are
 * the app's voice at the moments it has least to say, and the way they drift
 * is one screen at a time — "Nothing yet." here, "No runs yet." there, a bare
 * "—" somewhere else. Reading them as a list is how that gets caught.
 *
 * Every `failed` line names the thing that is missing rather than the verb
 * that failed, because "could not fetch" describes our afternoon and the
 * reader wants to know what they are now without.
 */
export const COPY = {
  stations: {
    loading: "Reading this project’s configuration…",
    empty: "No Stations yet — nobody is on this project.",
    emptyDetail: "Nothing here requires you to open the TOML.",
    action: "Add a Station",
    failed: "This project’s configuration could not be read.",
  },
  runs: {
    loading: "Reading this project’s runs…",
    empty: "No runs yet.",
    emptyDetail: "Press the key hint in the top bar, type a prompt, and go.",
    failed: "This project’s runs could not be read.",
  },
  events: {
    loading: "Reading this run’s log…",
    empty: "Nothing on the wire yet.",
    emptyDetail: "The harness has started and has not said anything so far.",
    failed: "This run’s log could not be read.",
  },
  ledger: {
    loading: "Reading run records…",
    empty: "Nothing spent yet.",
    emptyDetail: "A run has to finish before it can cost anything.",
    failed: "The ledger could not be read.",
  },
  projects: {
    loading: "Looking for your projects…",
    empty: "No projects yet.",
    failed: "The daemon could not be reached.",
  },
  harnesses: {
    loading: "Probing harnesses…",
    empty: "No harnesses are registered.",
    emptyDetail: "This is a build problem rather than a setup one.",
    failed: "The harnesses could not be probed.",
  },
} as const satisfies Record<string, SurfaceCopy>;
