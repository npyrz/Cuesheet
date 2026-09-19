/**
 * The project view: who is on this project, what each one is allowed to do,
 * what it has spent, and how close it is to a cap.
 *
 * Thin, like every other surface here — what a line *says* is decided in
 * `../posture.ts`, where tests can reach it, and that division matters more
 * on this screen than anywhere else: these are claims about what is
 * *enforced*, and a wrong one is worse than a blank panel because somebody
 * will seat a reviewer on the strength of it.
 *
 * **Why this is not the tile grid with more text on it.** A tile answers
 * "what is this Station doing right now" and is rebuilt from events; this
 * answers "what is this Station permitted to do", which comes from config and
 * does not move while you watch it. Step 43 rebuilds the live surface; the two
 * are deliberately separate screens because they are read at different moments
 * — one before you start work, one while it runs.
 */
import { useCallback, useEffect, useState } from "react";
import type { HarnessId, Ledger } from "@cuesheet/core";
import { fetchLedger, type StationsResponse } from "../api/client.js";
import {
  describePosture,
  spendLabel,
  type PermissionLine,
} from "../posture.js";
import { shortPath } from "../format.js";
import { toCell } from "../ledger.js";
import { COPY, describeSurface, LOADING, type Load } from "../surface.js";
import { firstStep, starterStation } from "../firstrun.js";
import { FirstRun } from "./FirstRun.js";
import { Notice } from "./Notice.js";

export interface ProjectViewProps {
  projectId: string;
  projectName: string;
  projectRoot: string;
  stations: StationsResponse | null;
  usage: Parameters<typeof describePosture>[1]["usage"];
  /** How the read that produced `stations` went. See `../surface.ts`. */
  load: Load;
  /** How many runs this project has ever had — Step 45's last move. */
  runCount: number;
  onAddStation: () => void;
  onAddStarter: (draft: ReturnType<typeof starterStation>) => Promise<void>;
  onStart: (prompt: string) => void;
  onOpenLedger: () => void;
  onRetry: () => void;
}

export function ProjectView({
  projectId,
  projectName,
  projectRoot,
  stations,
  usage,
  load,
  runCount,
  onAddStation,
  onAddStarter,
  onStart,
  onOpenLedger,
  onRetry,
}: ProjectViewProps): React.JSX.Element {
  const [ledger, ledgerLoad] = useProjectLedger(projectId);

  const rows =
    stations === null
      ? []
      : describePosture(stations.stations, {
          limits: stations.limits,
          usage,
          ledger,
        });

  /*
    All three of this surface's non-happy states, decided in one place rather
    than by a null check. `stations === null` used to mean both "in flight"
    and "the fetch threw", and this screen resolved that ambiguity by always
    guessing the first — so a daemon that went down left it reading "Reading
    this project's configuration…" for as long as anybody cared to wait.
  */
  const state = describeSurface(load, rows.length, COPY.stations);

  /*
    Step 45. The one move worth making next, or `null` when there is nothing
    to say. It replaces the empty state rather than sitting beside it: "No
    Stations yet" is an accurate description of a project and not an
    instruction to anybody, which is the whole difference this step is about.
  */
  const step =
    load.status === "ready" && stations !== null
      ? firstStep({
          harnesses: stations.harnesses,
          stations: rows.length,
          runs: runCount,
          projectName,
        })
      : null;

  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addStarter = useCallback(
    (harness: HarnessId) => {
      setAdding(true);
      setAddError(null);
      onAddStarter(
        starterStation(
          harness,
          projectRoot,
          (stations?.stations ?? []).map((view) => view.station.id),
        ),
      )
        .catch((cause: unknown) => {
          // The daemon's own words, next to the button that caused them —
          // the same argument `AddStationPanel` makes for not replacing them
          // with a generic failure.
          setAddError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setAdding(false));
    },
    [onAddStarter, projectRoot, stations],
  );

  return (
    <main className="project-view" id="work" tabIndex={-1}>
      <header className="project-head">
        <div>
          <h1 className="project-title">{projectName}</h1>
          <p className="project-where" title={projectRoot}>
            {shortPath(projectRoot)}
          </p>
        </div>
        <span className="spacer" />
        <div className="project-totals">
          {/*
            The project's own total, with the ledger a click away rather than
            redrawn here. Two surfaces for one number is how they drift.
          */}
          <button type="button" className="ghost" onClick={onOpenLedger}>
            {ledgerLabel(ledger, ledgerLoad)}
          </button>
        </div>
      </header>

      {stations !== null && (
        <p className="project-source">
          {stations.sourcePath === null
            ? "No cuesheet.toml — these are the defaults."
            : `Configured by ${shortPath(stations.sourcePath)}`}
        </p>
      )}

      {step !== null && (
        <FirstRun
          step={step}
          onAdd={addStarter}
          onRun={onStart}
          busy={adding}
          error={addError}
        />
      )}

      {state !== null ? (
        /*
          The guide above already said what to do about an empty project, so
          saying it again underneath would be the app telling somebody twice.
          Loading and error still get their notice: neither is advice.
        */
        step !== null && state.kind === "empty" ? null : (
          <Notice state={state} onAction={onAddStation} onRetry={onRetry} />
        )
      ) : (
        <ul className="posture">
          {rows.map((row) => (
            <li
              key={row.id}
              className="posture-card"
              data-available={row.available}
            >
              <div className="posture-head">
                <span className="posture-id">{row.id}</span>
                <span className="posture-role" data-role={row.role}>
                  {row.role}
                </span>
                <span className="posture-harness">
                  {row.harness}
                  {row.model === null ? "" : ` · ${row.model}`}
                </span>
                <span className="spacer" />
                {/*
                  Cap and spend on the same line as the name, because "how
                  close is it" and "what has it cost" are the two numbers
                  somebody scans a row for.
                */}
                {row.cap && (
                  <span
                    className="posture-cap"
                    data-tone={row.cap.tone}
                    title={row.cap.note}
                  >
                    {row.cap.window} {row.cap.value}
                  </span>
                )}
                {/*
                  Three reasons a row carries no money, and only one of them
                  is "never run" — see `spendLabel`. The ledger is allowed to
                  fail here without taking the permissions down with it, and
                  this column is where that failure is admitted.
                */}
                <span className="posture-spend">
                  {spendLabel(row.spend, ledgerLoad)}
                </span>
              </div>

              <p className="posture-purpose">{row.purpose}</p>
              <p className="posture-probe" data-ok={row.available}>
                {row.availability}
              </p>

              <ul className="posture-lines">
                {row.permissions.map((line, index) => (
                  <li
                    key={`${row.id}-${String(index)}`}
                    className="posture-line"
                    data-tone={line.tone}
                  >
                    <span className="posture-mark" aria-hidden="true">
                      {mark(line)}
                    </span>
                    <span className="posture-text">{line.text}</span>
                    {line.keptBy && (
                      <span className="posture-by">{keptBy(line)}</span>
                    )}
                  </li>
                ))}
              </ul>

              {row.cap && <p className="posture-capnote">{row.cap.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

/**
 * What the ledger button says.
 *
 * A project with no runs said "— across 0 runs", which is the dash the limits
 * strip uses for "nobody reported a number" being borrowed for "there is
 * nothing to report". They are different sentences and only one of them is
 * true here.
 */
function ledgerLabel(ledger: Ledger | null, load: Load): string {
  if (ledger === null)
    return load.status === "failed"
      ? "The ledger could not be read — try again"
      : "Open the ledger";
  if (ledger.totals.runs === 0) return "Nothing spent yet — open the ledger";
  const { usd } = toCell("total", ledger.totals);
  const runs = ledger.totals.runs;
  return `${usd} across ${String(runs)} run${runs === 1 ? "" : "s"} — open the ledger`;
}

/**
 * The glyph, which carries the same four meanings the tone does.
 *
 * Never colour alone: `data-tone` paints these, and a reader who cannot tell
 * the colours apart still has to be able to tell a refusal from a permission.
 * Full keyboard and contrast work is Step 44; this much is not worth deferring
 * on a screen whose entire job is saying what is forbidden.
 */
function mark(line: PermissionLine): string {
  switch (line.tone) {
    case "refused":
      return "✕";
    case "bounded":
      return "◑";
    case "allowed":
      return "✓";
    case "unknown":
      return "?";
  }
}

/** Who keeps the promise. The attribution is the point — see `roles.ts`. */
function keptBy(line: PermissionLine): string {
  switch (line.keptBy) {
    case "daemon":
      return "enforced by Cuesheet";
    case "harness":
      return "the harness’s own sandbox";
    case "leash":
      return "the leash";
    default:
      return "";
  }
}

/**
 * The project's ledger, fetched once when the screen opens.
 *
 * Not polled, matching `LedgerPanel`: it reads every run record in the
 * project. A failure is swallowed on purpose — spend is one column of this
 * screen, and a ledger that cannot be read must not take the permissions
 * with it, which are the part somebody came here for.
 */
function useProjectLedger(projectId: string): [Ledger | null, Load] {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [load, setLoad] = useState<Load>(LOADING);
  useEffect(() => {
    let live = true;
    setLedger(null);
    setLoad(LOADING);
    fetchLedger(projectId)
      .then((next) => {
        if (!live) return;
        setLedger(next);
        setLoad({ status: "ready" });
      })
      .catch((cause: unknown) => {
        // Still swallowed as far as the *screen* goes — but no longer as far
        // as the spend column goes, which was rendering "never run" for every
        // Station on the project and had no way to know better.
        if (!live) return;
        setLoad({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      live = false;
    };
  }, [projectId]);
  return [ledger, load];
}
