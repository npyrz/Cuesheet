/**
 * What this project's context already costs — Step 62.
 *
 * A section of the project view rather than a modal like the ledger, because
 * the question it answers belongs next to the Stations that pay it: adding a
 * Station is the single biggest thing that moves this number, and that button
 * is on this screen.
 *
 * Every sentence is decided in `../context.ts`, where a test can reach it.
 */
import { useCallback, useEffect, useState } from "react";
import type { ContextAudit } from "@cuesheet/core";
import { fetchContextAudit } from "../api/client.js";
import { contextRows, summarizeContext } from "../context.js";

export function ContextPanel({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const [audit, setAudit] = useState<ContextAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setAudit(null);
    setError(null);
    fetchContextAudit(projectId)
      .then((next) => {
        if (live) setAudit(next);
      })
      .catch((cause: unknown) => {
        // Kept to this section: an audit that cannot be read must not take
        // the permissions above it down, which are what somebody came for.
        if (live)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [projectId, attempt]);

  // Re-read on demand: the reason to look at this is usually that a file was
  // just trimmed, and the number should move when you ask it to.
  const reread = useCallback(() => setAttempt((n) => n + 1), []);

  if (error !== null) {
    return (
      <section className="context-audit" aria-label="Context cost">
        <h2 className="context-title">Context</h2>
        <p className="context-line">
          The context audit could not be read: {error}{" "}
          <button type="button" className="ghost" onClick={reread}>
            try again
          </button>
        </p>
      </section>
    );
  }
  if (audit === null) {
    return (
      <section className="context-audit" aria-label="Context cost">
        <h2 className="context-title">Context</h2>
        <p className="context-line">Measuring always-loaded context…</p>
      </section>
    );
  }

  const summary = summarizeContext(audit);
  const rows = contextRows(audit);
  return (
    <section className="context-audit" aria-label="Context cost">
      <div className="context-head">
        <h2 className="context-title">Context</h2>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={reread}>
          measure again
        </button>
      </div>
      <p className="context-headline">{summary.headline}</p>
      <p className="context-line">{summary.price}</p>
      {summary.history !== null && (
        <p className="context-line">{summary.history}</p>
      )}
      {summary.unknown !== null && (
        <p className="context-line" data-tone="unknown">
          {summary.unknown}
        </p>
      )}
      {rows.length > 0 && (
        <table className="ledger-table context-table">
          <caption>Loaded before every prompt</caption>
          <thead>
            <tr>
              <th scope="col">file</th>
              <th scope="col">size</th>
              <th scope="col">per run</th>
              <th scope="col">loaded by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-missing={row.missing}>
                <th scope="row">
                  {row.label}
                  {row.generated !== null && (
                    <span className="context-generated">{row.generated}</span>
                  )}
                </th>
                <td>{row.size}</td>
                <td>{row.perRun}</td>
                <td>{row.loadedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
