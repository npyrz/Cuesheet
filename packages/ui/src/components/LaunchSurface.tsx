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
 */
import type { ListedProject } from "@cuesheet/core";
import { describeRecents, emptyState } from "../launch.js";

export interface LaunchSurfaceProps {
  /** `null` while the first `GET /projects` is in flight. */
  projects: ListedProject[] | null;
  /** Electron only. Absent in a browser, which the zero state accounts for. */
  chooseDirectory?: (() => Promise<string | null>) | undefined;
  onOpen: (root: string) => void;
  onForget: (id: string) => void;
  error?: string | null;
}

export function LaunchSurface({
  projects,
  chooseDirectory,
  onOpen,
  onForget,
  error,
}: LaunchSurfaceProps): React.JSX.Element {
  const recents = projects === null ? [] : describeRecents(projects);
  const empty = emptyState(chooseDirectory !== undefined);

  return (
    <div className="launch">
      <div className="launch-inner">
        <h1 className="launch-brand">Cuesheet</h1>

        {projects === null ? (
          <p className="launch-detail">Looking for your projects…</p>
        ) : recents.length === 0 ? (
          <>
            <h2 className="launch-title">{empty.title}</h2>
            <p className="launch-detail">{empty.detail}</p>
          </>
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

        {chooseDirectory ? (
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
