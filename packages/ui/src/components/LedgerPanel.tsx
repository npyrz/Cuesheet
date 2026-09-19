/**
 * The ledger, as a table.
 *
 * **A table rather than a chart, deliberately.** Step 39's done-when reads
 * "a row in a chart"; there is no charting anything in this Desk, Phase 11
 * rebuilds it, and pulling in a visualization library to draw three bars would
 * be the expensive kind of scope. What the clause is actually asking for is
 * that the money be *visible and attributable*, and a row is a row.
 *
 * Thin, like `LimitsStrip`: every decision about what a number reads as lives
 * in `../ledger.ts`, which tests can reach.
 */
import { useCallback, useEffect, useState } from "react";
import type { Ledger } from "@cuesheet/core";
import { fetchLedger } from "../api/client.js";
import { useModal } from "../hooks/useModal.js";
import { toCell, unattributedNote, type LedgerCell } from "../ledger.js";
import {
  COPY,
  describeSurface,
  LOADING,
  READY,
  type Load,
} from "../surface.js";
import { Notice } from "./Notice.js";

export interface LedgerPanelProps {
  projectId: string;
  onClose: () => void;
}

export function LedgerPanel({
  projectId,
  onClose,
}: LedgerPanelProps): React.JSX.Element {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [load, setLoad] = useState<Load>(LOADING);
  const [attempt, setAttempt] = useState(0);
  const modal = useModal(onClose);

  // Fetched when opened rather than polled: it reads every run record in the
  // project, and nobody needs that on a timer behind a closed panel.
  useEffect(() => {
    let live = true;
    setLoad(LOADING);
    fetchLedger(projectId)
      .then((next) => {
        if (!live) return;
        setLedger(next);
        setLoad(READY);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setLoad({
          status: "failed",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      live = false;
    };
  }, [projectId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const note = ledger === null ? null : unattributedNote(ledger);
  /*
    Counted on runs rather than on rows, because `byDay` is empty for exactly
    the same reason the whole ledger is: nothing has run. A ledger with three
    empty tables in it is a worse way of saying so than a sentence.
  */
  const state = describeSurface(load, ledger?.totals.runs ?? 0, COPY.ledger);

  // Scrim, escape and click-outside, matching `AddStationPanel` exactly. Two
  // panels in one app that dismiss differently is the kind of inconsistency
  // nobody reports and everybody feels.
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
        aria-label="Ledger"
      >
        <header>Ledger</header>
        <div className="body">
          {/*
            Escape used to be listened for on this element and nothing ever
            focused it, so the key had nowhere to land. `useModal` focuses the
            panel on open, which is what makes the listener reachable — and
            traps Tab, which is what stops the third press reaching the stop
            button of a live run behind the scrim.
          */}
          {state !== null && <Notice state={state} onRetry={retry} />}

          {state === null && ledger !== null && (
            <>
              <Table
                caption="By day"
                rows={ledger.byDay.map((row) => toCell(row.key, row))}
              />
              <Table
                caption="By vendor"
                rows={ledger.byVendor.map((row) => toCell(row.key, row))}
              />
              <Table
                caption="By Station"
                rows={ledger.byStation.map((row) => toCell(row.key, row))}
              />
              {/*
                Printed whenever it is non-zero, never hidden. `byStation` not
                adding up to the total is the one discrepancy a reader would
                spot on their own, and an unexplained one costs the whole page
                its credibility.
              */}
              {note !== null && <p className="ledger-note">{note}</p>}
            </>
          )}
        </div>
        <footer>
          <span className="spacer" />
          <button type="button" className="ghost" onClick={onClose}>
            close
          </button>
        </footer>
      </div>
    </div>
  );
}

function Table({
  caption,
  rows,
}: {
  caption: string;
  rows: LedgerCell[];
}): React.JSX.Element {
  return (
    <table className="ledger-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{caption.replace("By ", "")}</th>
          <th scope="col">in</th>
          <th scope="col">out</th>
          {/* "cached" rather than "cache": it is a share of input, and the
              column reads `—` wherever nobody reported a breakdown. */}
          <th scope="col">cached</th>
          <th scope="col">cost</th>
          <th scope="col">runs</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={6} className="ledger-empty">
              Nothing yet.
            </td>
          </tr>
        ) : (
          rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.tokensIn}</td>
              <td>{row.tokensOut}</td>
              <td>{row.cache}</td>
              <td>{row.usd}</td>
              <td>{row.runs}</td>
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}
