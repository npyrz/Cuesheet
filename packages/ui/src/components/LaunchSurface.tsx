/**
 * What the app opens on when no project is active.
 *
 * Thin, like the other surfaces: every rule about what a row *says* lives in
 * `../launch.ts`, which tests can reach. What is here is markup and the two
 * actions.
 *
 * **Two renders, not one.** A first-ever launch and a launch with six known
 * projects are different screens and Step 40's done-when names both — so the
 * zero state is a sentence and an invitation rather than an empty list with a
 * button under it, and the loading state says what it is doing rather than
 * flashing the zero state for a beat on the way past.
 *
 * **Three, as of Step 44.** A daemon that cannot be reached was folded into
 * the loading state, which meant the first screen of the app read "Looking for
 * your projects…" for as long as anybody left it open. It is the one surface
 * where that is unrecoverable rather than merely wrong: the socket that
 * reconnects everything else does not attach until a project is open, so
 * nothing was going to come along and fix it.
 */
import type { ListedProject } from "@cuesheet/core";
import { describeRecents, emptyState } from "../launch.js";
import { describeSurface, type Load } from "../surface.js";
import { Notice } from "./Notice.js";

export interface LaunchSurfaceProps {
  projects: ListedProject[];
  /** How `GET /projects` went. See `../surface.ts`. */
  load: Load;
  /** Electron only. Absent in a browser, which the zero state accounts for. */
  chooseDirectory?: (() => Promise<string | null>) | undefined;
  onOpen: (root: string) => void;
  onForget: (id: string) => void;
  onRetry: () => void;
  error?: string | null;
}

export function LaunchSurface({
  projects,
  load,
  chooseDirectory,
  onOpen,
  onForget,
  onRetry,
  error,
}: LaunchSurfaceProps): React.JSX.Element {
  const recents = describeRecents(projects);
  const empty = emptyState(chooseDirectory !== undefined);
  /*
    The empty case keeps its own words rather than `COPY.projects`: Step 40
    wrote two of them, one for the desktop app and one for a browser with no
    folder picker, and a generic "No projects yet." would be a step backwards
    to save a branch. What `describeSurface` is here for is the other two —
    and for the rule that a failure never blanks a list that is already up.
  */
  const state = describeSurface(load, recents.length, {
    loading: "Looking for your projects…",
    empty: empty.title,
    emptyDetail: empty.detail,
    failed: "Cuesheet could not reach its daemon.",
  });

  return (
    <div className="launch">
      <div className="launch-inner">
        <h1 className="launch-brand">Cuesheet</h1>

        {state !== null ? (
          <Notice state={state} onRetry={onRetry} />
        ) : (
          <>
            <h2 className="launch-title">Recent projects</h2>
            <ul className="recents">
              {recents.map((row) => (
                <li
                  key={row.id}
                  className="recent"
                  data-openable={row.openable}
                >
                  {/*
                    A missing folder is not a click target. Disabled with its
                    reason showing, rather than clickable-and-then-an-error:
                    the daemon already knows the answer, and making somebody
                    discover it by pressing is a worse version of telling them.
                  */}
                  <button
                    type="button"
                    className="recent-open"
                    disabled={!row.openable}
                    title={row.root}
                    onClick={() => onOpen(row.root)}
                  >
                    <span className="recent-name">{row.name}</span>
                    <span className="recent-where">{row.where}</span>
                    <span className="recent-when">
                      {row.problem ?? row.when}
                    </span>
                  </button>
                  {/*
                    Always available, not only for broken entries — but it is
                    the broken ones that need it, because an entry that can
                    neither be opened nor removed is a dead end.
                  */}
                  <button
                    type="button"
                    className="ghost recent-forget"
                    onClick={() => onForget(row.id)}
                    title={`Forget ${row.name}. The folder is not touched.`}
                  >
                    forget
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {/*
          Still offered on every state but the error: a first-ever launch with
          no daemon cannot open anything, and a picker that ends in the same
          failure is a worse answer than the sentence above it.
        */}
        {state?.kind === "error" ? null : chooseDirectory ? (
          <button
            type="button"
            className="primary launch-open"
            onClick={() => {
              void chooseDirectory().then((picked) => {
                if (picked !== null) onOpen(picked);
              });
            }}
          >
            Open a folder…
          </button>
        ) : (
          recents.length > 0 && (
            <p className="launch-hint">
              The folder picker is part of the desktop app.
            </p>
          )
        )}

        {error != null && error !== "" && (
          <p className="launch-error">{error}</p>
        )}
      </div>
    </div>
  );
}
