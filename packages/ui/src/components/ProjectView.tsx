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
import { useEffect, useState } from "react";
import type { Ledger } from "@cuesheet/core";
import { fetchLedger, type StationsResponse } from "../api/client.js";
import { describePosture, type PermissionLine } from "../posture.js";
import { shortPath } from "../format.js";
import { toCell } from "../ledger.js";

export interface ProjectViewProps {
  projectId: string;
  projectName: string;
  projectRoot: string;
  stations: StationsResponse | null;
  usage: Parameters<typeof describePosture>[1]["usage"];
  onAddStation: () => void;
  onOpenLedger: () => void;
}

export function ProjectView({
  projectId,
  projectName,
  projectRoot,
  stations,
  usage,
  onAddStation,
  onOpenLedger,
}: ProjectViewProps): React.JSX.Element {
  const ledger = useProjectLedger(projectId);

  if (stations === null) {
    return (
      <main className="project-view">
        <p className="hint">Reading this project’s configuration…</p>
      </main>
    );
  }

  const rows = describePosture(stations.stations, {
    limits: stations.limits,
    usage,
    ledger,
  });

  return (
    <main className="project-view">
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
            {ledgerLabel(ledger)}
          </button>
        </div>
      </header>

      <p className="project-source">
        {stations.sourcePath === null
          ? "No cuesheet.toml — these are the defaults."
          : `Configured by ${shortPath(stations.sourcePath)}`}
      </p>

      {rows.length === 0 ? (
        <div className="posture-empty">
          <p>No Stations yet — nobody is on this project.</p>
          <button type="button" className="primary" onClick={onAddStation}>
            Add a Station
          </button>
        </div>
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
                <span className="posture-spend">
                  {row.spend === null
                    ? "never run"
                    : `${row.spend.usd} · ${row.spend.tokens} · ${row.spend.runs}`}
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
function ledgerLabel(ledger: Ledger | null): string {
  if (ledger === null) return "Open the ledger";
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
function useProjectLedger(projectId: string): Ledger | null {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  useEffect(() => {
    let live = true;
    setLedger(null);
    fetchLedger(projectId)
      .then((next) => {
        if (live) setLedger(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [projectId]);
  return ledger;
}
