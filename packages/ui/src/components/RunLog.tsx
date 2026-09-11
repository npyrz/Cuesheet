/**
 * The run list and the stream beneath the tiles — the bottom half of the
 * README's Desk drawing.
 */
import { useEffect, useRef, useState } from "react";
import type { Run, RunEvent } from "@cuesheet/core";
import { isTerminalStatus } from "@cuesheet/core/types";
import { duration, elapsed, money, shortPath, statusDot } from "../format.js";

export interface RunLogProps {
  runs: Run[];
  selected: Run | null;
  events: RunEvent[];
  onSelect: (runId: string) => void;
  onStop: (runId: string) => void;
  loadDiff: (runId: string) => Promise<string | null>;
}

export function RunLog({
  runs,
  selected,
  events,
  onSelect,
  onStop,
  loadDiff,
}: RunLogProps): React.JSX.Element {
  return (
    <section className="runs">
      <ul className="run-list" aria-label="Runs">
        {runs.length === 0 && <li className="empty">No runs yet.</li>}
        {runs.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className="run-row"
              aria-current={run.id === selected?.id}
              onClick={() => onSelect(run.id)}
            >
              <span className="prompt">
                {statusDot(run.status)} {run.prompt || "(no prompt)"}
              </span>
              <span className="meta">
                <span>{run.status}</span>
                <span>{money(run.cost)}</span>
                {run.result && <span>{duration(run.result.durationMs)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="run-pane">
        {selected === null ? (
          <p className="empty">Select a run.</p>
        ) : (
          <RunDetail
            run={selected}
            events={events}
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
  onStop,
  loadDiff,
}: {
  run: Run;
  events: RunEvent[];
  onStop: (runId: string) => void;
  loadDiff: (runId: string) => Promise<string | null>;
}): React.JSX.Element {
  const running = !isTerminalStatus(run.status);

  return (
    <>
      <div className="run-head">
        <span className="run-title">
          {statusDot(run.status)} “{run.prompt || "(no prompt)"}”
        </span>
        <span className="hint">{run.status}</span>
        <span className="hint">{money(run.cost)}</span>
        {run.startedAt && (
          <span className="hint">{elapsed(run.startedAt, run.finishedAt)}</span>
        )}
        {run.result?.diff && (
          <span className="hint">
            {run.result.diff.filesChanged} files · +{run.result.diff.insertions}{" "}
            −{run.result.diff.deletions}
          </span>
        )}
        <span className="spacer" />
        {running && (
          <button type="button" onClick={() => onStop(run.id)}>
            stop
          </button>
        )}
      </div>

      {run.error && <p className="field-error">{run.error}</p>}

      <Gates run={run} />

      <EventList events={events} follow={running} />
      <Diff runId={run.id} load={loadDiff} />
    </>
  );
}

function EventList({
  events,
  follow,
}: {
  events: RunEvent[];
  follow: boolean;
}): React.JSX.Element {
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    // Follow the tail only while the run is live. Yanking a finished log back
    // to the bottom while someone is reading the middle of it is hostile.
    if (!follow || !list.current) return;
    list.current.scrollTop = list.current.scrollHeight;
  }, [events.length, follow]);

  if (events.length === 0) {
    return <p className="empty">No events.</p>;
  }

  return (
    <ul className="log" ref={list} aria-label="Run events">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`}>
          <span className="t">{clock(event.at)}</span>
          <span className="kind" data-t={event.t}>
            {event.t}
          </span>
          <span className="msg">{describe(event)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One line per event.
 *
 * A `switch` over the discriminant rather than a lookup table, so adding a
 * variant to `RunEvent` is a compile error here — which is exactly the
 * property the union was defined for.
 */
function describe(event: RunEvent): string {
  switch (event.t) {
    case "status":
      return event.status;
    case "text":
      return event.chunk;
    case "tool":
      return `${event.stationId} · ${event.name}`;
    case "file":
      return `${event.op} ${shortPath(event.path, 3)}`;
    case "standby":
      return event.ask;
    case "denial":
      return `${event.reason}${event.path ? ` — ${event.path}` : ""}`;
    case "cost":
      return `${event.tokensIn} in / ${event.tokensOut} out${
        event.usd === undefined ? "" : ` · $${event.usd.toFixed(4)}`
      }`;
    case "done": {
      const { diff, durationMs } = event.result;
      const shape = diff
        ? `${diff.filesChanged} files, +${diff.insertions} −${diff.deletions}`
        : "no changes";
      return `${event.result.status} · ${shape} · ${duration(durationMs)}`;
    }
    case "verdict": {
      const { decision, findings, vendor } = event.verdict;
      // The findings are the useful half: "fail" without the reason sends you
      // hunting through the transcript for what the reviewer objected to.
      const detail =
        findings.length === 0
          ? "no findings"
          : findings
              .map((finding) => `${finding.category}: ${finding.summary}`)
              .join("; ");
      return `${vendor} ${decision} — ${detail}`;
    }
    case "error":
      return event.message;
  }
}

/**
 * What the Gates decided, and what the reviewers found.
 *
 * A Hold's reasons are on the run record, but the *findings* are on the
 * verdicts — and "held: 1 blocking finding" without the finding sends you
 * hunting through the transcript for what was actually wrong. Both, or this
 * panel is not worth the space.
 *
 * Renders nothing for a run with no gates and no verdicts, which is every run
 * from a plain prompt.
 */
function Gates({ run }: { run: Run }): React.JSX.Element | null {
  const gates = run.result?.gates ?? [];
  const verdicts = run.result?.verdicts ?? [];
  if (gates.length === 0 && verdicts.length === 0) return null;

  return (
    <div className="gates">
      {gates.map((gate) => (
        <p key={gate.gate} className="gate-line">
          <span className={`gate-outcome gate-${gate.outcome}`}>
            {gate.outcome === "hold" && gate.overridden
              ? "overridden"
              : gate.outcome}
          </span>
          <span className="gate-name">gate “{gate.gate}”</span>
          <span className="hint">{gate.reasons.join(" ")}</span>
        </p>
      ))}

      {verdicts.map((verdict) => (
        <div key={verdict.id} className="verdict">
          <p className="gate-line">
            <span className={`gate-outcome gate-${verdict.decision}`}>
              {verdict.decision}
            </span>
            <span className="gate-name">
              {verdict.stationId} · {verdict.vendor}
            </span>
          </p>
          {verdict.findings.map((finding, index) => (
            <p key={`${verdict.id}-${index}`} className="finding">
              <span className={`sev sev-${finding.severity}`}>
                {finding.category}
              </span>
              {finding.summary}
            </p>
          ))}
        </div>
      ))}
    </div>
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
