/**
 * The live run.
 *
 * Replaces Phase 4's run pane, which rendered every event as one row of the
 * same shape. That was right for proving a daemon could stream into a browser
 * and wrong for the thing this app most needs to say: a reviewer's blocking
 * finding arrived between a tool call and a cost line, in the same typeface,
 * under whatever came before it.
 *
 * So the order here is by *what it costs to miss*, not by arrival: the
 * headline, then the findings and the Gates that acted on them, then the
 * stream, then the diff. What each of those says is decided in `../runview.ts`
 * where tests can reach it — including the test that replays the Phase 7 gate
 * run through the reducer and asserts the finding is the thing at the top.
 */
import { useEffect, useRef, useState } from "react";
import type { Run, RunEvent } from "@cuesheet/core";
import { describeRun, runRowMark, type TimelineEntry } from "../runview.js";
import { money, statusDot } from "../format.js";
import { rove } from "../keys.js";
import {
  COPY,
  describeSurface,
  LOADING,
  READY,
  type Load,
} from "../surface.js";
import { Notice } from "./Notice.js";

export interface RunSurfaceProps {
  runs: Run[];
  selected: Run | null;
  events: RunEvent[];
  /** Whether this session has read the selected run's log. See the reducer. */
  eventsLoaded: boolean;
  /** How the read that produced `runs` went. See `../surface.ts`. */
  load: Load;
  onSelect: (runId: string) => void;
  onStop: (runId: string) => void;
  onRetry: () => void;
  loadDiff: (runId: string) => Promise<string | null>;
}

export function RunSurface({
  runs,
  selected,
  events,
  eventsLoaded,
  load,
  onSelect,
  onStop,
  onRetry,
  loadDiff,
}: RunSurfaceProps): React.JSX.Element {
  const list = useRef<HTMLUListElement>(null);
  const state = describeSurface(load, runs.length, COPY.runs);

  /**
   * The arrows walk the list; the selection follows the focus.
   *
   * Fifty rows beside a pane means fifty Tab presses to get past something
   * nobody was reading, which is what "operable from the keyboard" fails to
   * mean if a list is only tabbable. Where an arrow key goes is decided in
   * `../keys.ts`, where a test can reach it; what is here is the focus call.
   */
  const onListKey = (event: React.KeyboardEvent<HTMLUListElement>): void => {
    const rows = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(".run-row") ?? []),
    ];
    const next = rove(event.key, {
      count: rows.length,
      current: rows.indexOf(document.activeElement as HTMLButtonElement),
    });
    if (next === null) return;
    // Only now, so Tab still leaves the list and the page still scrolls with
    // the arrows when focus is anywhere else.
    event.preventDefault();
    const row = rows[next];
    row?.focus();
    const runId = row?.dataset["runId"];
    // Selecting on focus rather than on Enter: the pane is what the list is
    // for, and a highlight that shows nothing until you press again is two
    // keystrokes pretending to be one.
    if (runId !== undefined) onSelect(runId);
  };

  return (
    <section className="runs">
      <ul
        className="run-list"
        aria-label="Runs"
        ref={list}
        onKeyDown={onListKey}
      >
        {state !== null && (
          <li>
            <Notice state={state} onRetry={onRetry} />
          </li>
        )}
        {runs.map((run) => {
          const mark = runRowMark(run);
          return (
            <li key={run.id}>
              <button
                type="button"
                className="run-row"
                data-run-id={run.id}
                aria-current={run.id === selected?.id}
                // One stop for the whole list, then arrows inside it. A
                // roving tabindex rather than fifty tab stops.
                tabIndex={
                  run.id === (selected?.id ?? runs[0]?.id) ? undefined : -1
                }
                onClick={() => onSelect(run.id)}
              >
                <span className="prompt">
                  {statusDot(run.status)} {run.prompt || "(no prompt)"}
                </span>
                {/*
                  The row carries the finding too. "Seen first" is not
                  satisfied by a pane you have to open — the list is what you
                  see before you click, and a row reading only `held` sends
                  somebody hunting for the reason.
                */}
                {mark && (
                  <span className="run-mark" data-tone={mark.tone}>
                    {mark.label}
                  </span>
                )}
                <span className="meta">
                  <span>{run.status}</span>
                  <span>{money(run.cost, run.status)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="run-pane">
        {selected === null ? (
          /*
            Not one of the three: there are runs, the read succeeded, and this
            pane is waiting on a *choice*. Calling it empty would blame the
            project for something the cursor is responsible for. It borrows the
            three states' presentation and none of their claims.
          */
          <div className="notice" data-kind="idle" role="status">
            <p className="notice-title">
              {runs.length === 0 ? "No run to show." : "Select a run."}
            </p>
          </div>
        ) : (
          <RunDetail
            run={selected}
            events={events}
            eventsLoaded={eventsLoaded}
            onStop={onStop}
            loadDiff={loadDiff}
          />
        )}
      </div>
    </section>
  );
}

function RunDetail({
  run,
  events,
  eventsLoaded,
  onStop,
  loadDiff,
}: {
  run: Run;
  events: RunEvent[];
  eventsLoaded: boolean;
  onStop: (runId: string) => void;
  loadDiff: (runId: string) => Promise<string | null>;
}): React.JSX.Element {
  const view = describeRun(run, events);

  return (
    <>
      <div className="run-head">
        <span className="run-title">
          {statusDot(run.status)} “{run.prompt || "(no prompt)"}”
        </span>
        <span className="hint">{run.status}</span>
        <span className="hint">{view.totals.cost}</span>
        {view.totals.tokens && (
          <span className="hint">{view.totals.tokens}</span>
        )}
        {view.totals.duration && (
          <span className="hint">{view.totals.duration}</span>
        )}
        {view.totals.diff && <span className="hint">{view.totals.diff}</span>}
        <span className="spacer" />
        {view.running && (
          <button type="button" onClick={() => onStop(run.id)}>
            stop
          </button>
        )}
      </div>

      {/*
        Above everything, including the stream. This is the whole of Step 43's
        done-when: the most important thing this app can tell you is not
        another line in a log.
      */}
      {view.headline && (
        <div className="headline" data-tone={view.headline.tone} role="status">
          <p className="headline-title">{view.headline.title}</p>
          {view.headline.lines.map((line, index) => (
            <p key={index} className="headline-line">
              {line}
            </p>
          ))}
        </div>
      )}

      {view.findings.length > 0 && (
        <ul className="findings" aria-label="Findings">
          {view.findings.map((finding) => (
            <li
              key={finding.key}
              className="finding-row"
              data-tone={finding.tone}
            >
              <span className="finding-sev">{finding.severity}</span>
              <span className="finding-cat">{finding.category}</span>
              <span className="finding-text">{finding.summary}</span>
              {finding.where && (
                <span className="finding-where">{finding.where}</span>
              )}
              <span className="finding-by">{finding.by}</span>
            </li>
          ))}
        </ul>
      )}

      {view.gates.length > 0 && (
        <ul className="gates" aria-label="Gates">
          {view.gates.map((gate) => (
            <li key={gate.gate} className="gate-row" data-tone={gate.tone}>
              <span className="gate-outcome">
                {gate.overridden ? "overridden" : gate.outcome}
              </span>
              <span className="gate-name">gate “{gate.gate}”</span>
              <span className="gate-reasons">{gate.reasons.join(" ")}</span>
            </li>
          ))}
        </ul>
      )}

      <Timeline
        entries={view.timeline}
        follow={view.running}
        load={eventsLoaded ? READY : LOADING}
      />
      <Diff runId={run.id} load={loadDiff} />
    </>
  );
}

function Timeline({
  entries,
  follow,
  load,
}: {
  entries: TimelineEntry[];
  follow: boolean;
  load: Load;
}): React.JSX.Element {
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    // Follow the tail only while the run is live. Yanking a finished log back
    // to the bottom while somebody is reading the middle of it is hostile.
    if (!follow || !list.current) return;
    list.current.scrollTop = list.current.scrollHeight;
  }, [entries.length, follow]);

  const state = describeSurface(load, entries.length, COPY.events);
  if (state !== null) {
    // "No events." was said for both a log that has not been fetched and a
    // run that has genuinely not spoken yet. They are different facts, and
    // only one of them is about the run.
    return <Notice state={state} />;
  }

  return (
    <ul className="log" ref={list} aria-label="Run events">
      {entries.map((entry) => (
        <li
          key={entry.key}
          className="log-row"
          data-kind={entry.kind}
          data-tone={entry.tone}
        >
          <span className="t">{clock(entry.at)}</span>
          <span className="kind" data-t={entry.kind}>
            {entry.kind}
          </span>
          <span className="msg">
            {entry.stationId !== null && entry.kind !== "text" && (
              <span className="who">{entry.stationId}</span>
            )}
            <span className="what">{entry.text}</span>
            {entry.detail !== null && (
              <span className="detail">{entry.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The patch, fetched only when someone asks for it.
 *
 * Phase 3 left a known hazard here: a workspace with a large untracked tree
 * (an un-gitignored `node_modules`) produces a multi-megabyte `diff.patch`.
 * That is why this is a button and its own request rather than part of
 * `GET /runs/:id`.
 */
function Diff({
  runId,
  load,
}: {
  runId: string;
  load: (runId: string) => Promise<string | null>;
}): React.JSX.Element | null {
  const [patch, setPatch] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none" | "shown">(
    "idle",
  );

  // Collapse whenever the selected run changes, so the previous run's patch
  // is never shown under a new run's header.
  useEffect(() => {
    setPatch(null);
    setState("idle");
  }, [runId]);

  if (state === "shown" && patch !== null) {
    return (
      <>
        <button type="button" className="link" onClick={() => setState("idle")}>
          hide diff
        </button>
        <pre className="diff">
          {patch.split("\n").map((line, index) => (
            <span key={index} className={lineClass(line)}>
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      </>
    );
  }

  return (
    <button
      type="button"
      className="link"
      disabled={state === "loading"}
      onClick={() => {
        if (patch !== null) {
          setState("shown");
          return;
        }
        setState("loading");
        void load(runId)
          .then((text) => {
            setPatch(text);
            setState(text === null ? "none" : "shown");
          })
          .catch(() => setState("none"));
      }}
    >
      {state === "loading"
        ? "loading diff…"
        : state === "none"
          ? "no diff"
          : "open diff"}
    </button>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "";
}

/** `14:22:33` — the date is the run's, not the line's. */
function clock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "--:--:--";
  return at.toLocaleTimeString(undefined, { hour12: false });
}
