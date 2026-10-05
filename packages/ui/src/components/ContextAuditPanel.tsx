import { useEffect, useState } from "react";
import type { ContextLoadAudit } from "@cuesheet/core";
import { fetchContextLoadAudit } from "../api/client.js";
import { useModal } from "../hooks/useModal.js";

export function ContextAuditPanel({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}): React.JSX.Element {
  const modal = useModal(onClose);
  const [audit, setAudit] = useState<ContextLoadAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState(1);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setAudit(null);
    setError(null);
    fetchContextLoadAudit(projectId, runs)
      .then((next) => {
        if (live) setAudit(next);
      })
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [projectId, runs, attempt]);
  const number = (value: number | null): string =>
    value === null ? "unknown" : value.toLocaleString("en-US");
  return (
    <div
      className="scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        {...modal}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Context cost"
      >
        <header>Context cost</header>
        <div className="body">
          <p>
            Estimated tokens in always-loaded context, per Station and per run.
          </p>
          <label>
            Runs to estimate{" "}
            <input
              type="number"
              min={1}
              max={1000000}
              value={runs}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isSafeInteger(next) && next >= 1 && next <= 1000000)
                  setRuns(next);
              }}
            />
          </label>
          {error !== null ? (
            <p role="alert">{error}</p>
          ) : audit === null ? (
            <p role="status">Reading context files…</p>
          ) : (
            <>
              <p>
                <strong>
                  {number(audit.estimatedTokensAcrossStations)} estimated tokens
                </strong>{" "}
                for one invocation of every Station
                {audit.complete ? "." : " (partial/unknown)."}
              </p>
              <table className="ledger-table">
                <caption>Per run — estimated tokens</caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Per run</th>
                    <th scope="col">Across {runs} runs</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.plans.map((plan) => (
                    <tr
                      key={
                        plan.cuesheet === null
                          ? "default"
                          : `cuesheet:${plan.cuesheet}`
                      }
                    >
                      <th scope="row">
                        {plan.cuesheet === null
                          ? "Default (first Station)"
                          : plan.cuesheet}
                        {plan.complete ? "" : " (partial/unknown)"}
                      </th>
                      <td>{number(plan.estimatedTokensPerRun)}</td>
                      <td>{number(plan.estimatedTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <table className="ledger-table">
                <caption>By Station — estimated tokens per invocation</caption>
                <thead>
                  <tr>
                    <th scope="col">Station</th>
                    <th scope="col">Harness</th>
                    <th scope="col">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.stations.map((station) => (
                    <tr key={station.id}>
                      <th scope="row">
                        {station.id}
                        {station.complete ? "" : " (partial/unknown)"}
                        {station.reason === undefined
                          ? ""
                          : ` — ${station.reason}`}
                      </th>
                      <td>{station.harness}</td>
                      <td>{number(station.estimatedTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {audit.stations.length === 0 && (
                <p>
                  No Stations configured. Add a Station to estimate its context.
                </p>
              )}
              <table className="ledger-table context-files">
                <caption>Files — estimated tokens per load</caption>
                <thead>
                  <tr>
                    <th scope="col">File / Stations</th>
                    <th scope="col">Tokens</th>
                    <th scope="col">Of which projection</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.files.map((file) => (
                    <tr key={file.path}>
                      <th scope="row">
                        {file.path}
                        <br />
                        {file.scope} · {file.state} ·{" "}
                        {file.stationIds.join(", ")}
                        {file.error === undefined ? "" : ` — ${file.error}`}
                      </th>
                      <td>{number(file.estimatedTokens)}</td>
                      <td>{number(file.projectionEstimatedTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {audit.files.length === 0 && (
                <p>No declared context files for these Stations.</p>
              )}
              {audit.notes.map((note) => (
                <p className="ledger-note" key={note}>
                  {note}
                </p>
              ))}
            </>
          )}
        </div>
        <footer>
          <button
            type="button"
            className="ghost"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Refresh
          </button>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            close
          </button>
        </footer>
      </div>
    </div>
  );
}
