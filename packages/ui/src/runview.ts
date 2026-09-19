/**
 * What a run *says*, as opposed to what it logged.
 *
 * Pure, and in a `.ts` for the reason `posture.ts`, `limits.ts`, `ledger.ts`,
 * `launch.ts` and `switcher.ts` are: vitest collects colocated `.test.ts` only
 * and does not collect `.tsx`.
 *
 * ## The rule this file exists to keep
 *
 * **A blocking finding is the most important thing this app can tell you, and
 * it must not arrive as another line in a log.** Phase 4's run pane rendered
 * every event as one row of the same shape, so a reviewer's "this allows
 * unbounded memory growth and eventual denial of service" sat between a tool
 * call and a cost line, in the same typeface, below whatever came before it.
 *
 * So the surface leads with a headline, and the headline is chosen by
 * severity rather than by recency. Two consequences worth stating because
 * both are easy to get backwards:
 *
 * - **Severity is read off the finding, never off the decision.** A reviewer
 *   can pass *and* file a blocking finding — `mock`'s `review: "blocking"` is
 *   that case on purpose, because a real reviewer does it — and a surface that
 *   keyed on `decision` would show a green pass over a security hole.
 * - **`held` is not the headline when a finding explains it.** "This run is
 *   held" is a restatement of the status; the finding is the thing somebody
 *   needs to read.
 *
 * ## Two different things are called "blocking", and the surface must not blur
 * ## them
 *
 * `Finding.severity: "block"` is the *reviewer's* judgement. A Gate's
 * `blocking` is a list of **categories the operator declared hold-worthy**,
 * and `core/gate.ts` holds on that list — not on severity. So a reviewer can
 * file `severity: "block"` in a category no Gate names, and the run finishes
 * clean. That happened the first time this surface was driven against a real
 * two-vendor gate run, and a headline reading "a reviewer filed a blocking
 * finding" over a run that was never held is a surface implying a hold that
 * did not happen. The headline says which of the two it is.
 */
import { isTerminalStatus } from "@cuesheet/core/types";
import type { Finding, Run, RunEvent, Verdict } from "@cuesheet/core";
import { duration, money, shortPath, tokens } from "./format.js";

export type Tone = "block" | "warn" | "refused" | "good" | "plain";

/** What the pane leads with, or `null` when the status says it all. */
export interface Headline {
  kind: "blocking" | "error" | "standby" | "held";
  title: string;
  /** One line per thing that earned the headline. Never empty. */
  lines: string[];
  tone: Tone;
}

export interface FindingRow {
  key: string;
  /** Which Station filed it, and on whose model — a Gate counts vendors. */
  by: string;
  category: string;
  severity: Finding["severity"];
  summary: string;
  /** `src/upload.js:42`, or `null` when the reviewer did not locate it. */
  where: string | null;
  tone: Tone;
}

export interface GateRow {
  gate: string;
  outcome: "pass" | "hold" | "skipped";
  /** `overridden` is a hold a human waved through; it is not a pass. */
  overridden: boolean;
  reasons: string[];
  tone: Tone;
}

export interface TimelineEntry {
  key: string;
  at: string;
  kind:
    | "status"
    | "text"
    | "tool"
    | "file"
    | "standby"
    | "denial"
    | "verdict"
    | "done"
    | "error";
  stationId: string | null;
  text: string;
  /** The second line, when there is one: a command, a path, a finding. */
  detail: string | null;
  tone: Tone;
}

export interface RunView {
  headline: Headline | null;
  findings: FindingRow[];
  gates: GateRow[];
  timeline: TimelineEntry[];
  /** The header's numbers, already formatted. */
  totals: {
    cost: string;
    tokens: string | null;
    duration: string | null;
    diff: string | null;
  };
  running: boolean;
}

export function describeRun(run: Run, events: readonly RunEvent[]): RunView {
  const verdicts = collectVerdicts(run, events);
  const findings = findingRows(verdicts);
  const gates = gateRows(run);

  return {
    headline: headlineFor(run, events, findings),
    findings,
    gates,
    timeline: timelineFrom(events),
    totals: totalsFor(run),
    running: !isTerminalStatus(run.status),
  };
}

/**
 * Every verdict this run has, from wherever it survived.
 *
 * A live run has them as events and nothing else; a finished one has them on
 * its record, and a run opened from the list may have both — the resync
 * fetches the log *and* the record. De-duplicated by verdict id, because
 * rendering the same finding twice is how a surface teaches somebody to stop
 * believing the count in the headline.
 */
function collectVerdicts(run: Run, events: readonly RunEvent[]): Verdict[] {
  const byId = new Map<string, Verdict>();
  for (const verdict of run.result?.verdicts ?? [])
    byId.set(verdict.id, verdict);
  for (const event of events) {
    if (event.t === "verdict") byId.set(event.verdict.id, event.verdict);
  }
  return [...byId.values()];
}

/**
 * Findings, worst first.
 *
 * Sorted rather than filtered: an `info` finding is worth reading, just not
 * worth leading with, and a reviewer that filed three things should not have
 * two of them disappear because one was serious.
 */
function findingRows(verdicts: readonly Verdict[]): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const verdict of verdicts) {
    verdict.findings.forEach((finding, index) => {
      rows.push({
        key: `${verdict.id}-${String(index)}`,
        by: `${verdict.stationId} · ${verdict.vendor}`,
        category: finding.category,
        severity: finding.severity,
        summary: finding.summary,
        where: locate(finding),
        tone: toneOf(finding.severity),
      });
    });
  }
  return rows.sort((a, b) => rank(b.severity) - rank(a.severity));
}

function locate(finding: Finding): string | null {
  if (finding.path === undefined) return null;
  const path = shortPath(finding.path, 2);
  return finding.line === undefined ? path : `${path}:${String(finding.line)}`;
}

function rank(severity: Finding["severity"]): number {
  return severity === "block" ? 2 : severity === "warn" ? 1 : 0;
}

function toneOf(severity: Finding["severity"]): Tone {
  return severity === "block"
    ? "block"
    : severity === "warn"
      ? "warn"
      : "plain";
}

function gateRows(run: Run): GateRow[] {
  return (run.result?.gates ?? []).map((gate) => ({
    gate: gate.gate,
    outcome: gate.outcome,
    overridden: gate.overridden === true,
    reasons: gate.reasons,
    // An overridden hold is drawn as a warning rather than a pass: somebody
    // decided to carry on, which is a different fact from the gate agreeing.
    tone:
      gate.outcome === "hold"
        ? gate.overridden === true
          ? "warn"
          : "block"
        : gate.outcome === "pass"
          ? "good"
          : "plain",
  }));
}

/**
 * The one thing to read first, chosen by what it costs to miss.
 *
 * Order: a blocking finding, then a failure, then a question waiting on a
 * human, then a Hold with no finding behind it. Anything else has no headline
 * — a run that is simply running does not need one, and a surface that
 * announces every state teaches people to skip the announcement.
 */
function headlineFor(
  run: Run,
  events: readonly RunEvent[],
  findings: readonly FindingRow[],
): Headline | null {
  const blocking = findings.filter((finding) => finding.severity === "block");
  if (blocking.length > 0) {
    // Whether anything actually stopped: a Gate that held, or a run that ended
    // held or failed. The finding leads either way — it is the thing worth
    // reading — but the sentence must not imply a hold that did not happen.
    const stopped =
      run.status === "held" ||
      run.status === "failed" ||
      (run.result?.gates ?? []).some(
        (gate) => gate.outcome === "hold" && gate.overridden !== true,
      );
    // "Nothing stopped this run" is a claim about an outcome, so it is only
    // made once there is one. A live run that has a verdict but no gate report
    // yet — which is every run sitting on a Hold's standby, where the gate's
    // own record does not exist until the run ends — would otherwise be told
    // it got away with it while it is in fact waiting to be answered.
    const decided = isTerminalStatus(run.status);
    const count =
      blocking.length === 1
        ? "a blocking finding"
        : `${String(blocking.length)} blocking findings`;
    return {
      kind: "blocking",
      title:
        !stopped && decided
          ? `A reviewer filed ${count}, and nothing stopped this run.`
          : `A reviewer filed ${count}.`,
      lines: blocking.map(
        (finding) =>
          `${finding.category}: ${finding.summary}${finding.where === null ? "" : ` (${finding.where})`}`,
      ),
      tone: stopped || !decided ? "block" : "warn",
    };
  }

  if (run.error !== undefined && run.error !== "") {
    return {
      kind: "error",
      title: run.status === "held" ? "This run is held." : "This run failed.",
      lines: [run.error],
      tone: run.status === "held" ? "block" : "refused",
    };
  }

  // A standby that has been answered leaves its event behind, so this asks the
  // run whether it is still waiting rather than trusting the log.
  const waiting = run.status === "standby" ? lastStandby(events) : null;
  if (waiting !== null) {
    return {
      kind: "standby",
      title: "Waiting on you.",
      lines: [waiting],
      tone: "warn",
    };
  }

  const held = (run.result?.gates ?? []).find(
    (gate) => gate.outcome === "hold" && gate.overridden !== true,
  );
  if (held !== undefined) {
    return {
      kind: "held",
      title: `Gate “${held.gate}” held this run.`,
      lines:
        held.reasons.length > 0 ? held.reasons : ["No reason was recorded."],
      tone: "block",
    };
  }

  return null;
}

function lastStandby(events: readonly RunEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.t === "standby") return event.ask;
  }
  return null;
}

/**
 * The stream, as the three real harnesses actually emit it.
 *
 * Two things this does that Phase 4's list did not, both learned from real
 * captures rather than from `mock`:
 *
 * - **Prose is coalesced per Station.** Claude Code streams text in chunks of
 *   a few words; one row each turned a paragraph into forty rows of chrome.
 *   The break is on the *Station*, not only on the event kind, because a
 *   two-vendor run interleaves the engineer's prose with the reviewer's — and
 *   merging those would put the reviewer's objection inside the engineer's
 *   paragraph, in the one run this step is measured on.
 * - **Cost events are not rows.** Every harness emits them continuously and
 *   nobody reads them one at a time; the total belongs in the header, which is
 *   where {@link totalsFor} puts it.
 */
export function timelineFrom(events: readonly RunEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let prose: { entry: TimelineEntry; stationId: string } | null = null;

  events.forEach((event, index) => {
    const key = `${event.at}-${String(index)}`;

    if (event.t === "text") {
      if (prose !== null && prose.stationId === event.stationId) {
        prose.entry.text += event.chunk;
        return;
      }
      const entry: TimelineEntry = {
        key,
        at: event.at,
        kind: "text",
        stationId: event.stationId,
        text: event.chunk,
        detail: null,
        tone: "plain",
      };
      prose = { entry, stationId: event.stationId };
      entries.push(entry);
      return;
    }

    // A cost event is not a row and must not break a paragraph either. Every
    // harness emits them continuously — in the live mock run this was written
    // against, they fell between consecutive sentences and split one thought
    // into four rows, which is the exact chrome the coalescing exists to
    // remove.
    if (event.t === "cost") return;

    // Anything else that is not prose ends the paragraph, so a tool call
    // cannot land inside one and a resumed paragraph starts its own row.
    prose = null;

    entries.push(entryFor(event, key));
  });

  for (const entry of entries) {
    if (entry.kind === "text") entry.text = entry.text.trim();
  }
  return entries.filter((entry) => entry.kind !== "text" || entry.text !== "");
}

function entryFor(
  event: Exclude<RunEvent, { t: "text" } | { t: "cost" }>,
  key: string,
): TimelineEntry {
  const base = { key, at: event.at };
  switch (event.t) {
    case "status":
      return {
        ...base,
        kind: "status",
        stationId: null,
        text: event.status,
        detail: null,
        tone: "plain",
      };
    case "tool":
      return {
        ...base,
        kind: "tool",
        stationId: event.stationId,
        text: event.name,
        detail: toolSummary(event.name, event.input),
        tone: "plain",
      };
    case "file":
      return {
        ...base,
        kind: "file",
        stationId: event.stationId,
        text: event.op === "write" ? "wrote" : "read",
        detail: shortPath(event.path, 3),
        tone: event.op === "write" ? "good" : "plain",
      };
    case "standby":
      return {
        ...base,
        kind: "standby",
        stationId: null,
        text: event.ask,
        detail: null,
        tone: "warn",
      };
    case "denial":
      return {
        ...base,
        kind: "denial",
        stationId: null,
        // The leash doing its job is not an error, and it is not noise
        // either: it is the only visible evidence that a boundary held.
        text: event.reason,
        detail: event.path === undefined ? null : shortPath(event.path, 3),
        tone: "refused",
      };
    case "verdict": {
      const { decision, findings, vendor } = event.verdict;
      const worst = findings.some((finding) => finding.severity === "block");
      return {
        ...base,
        kind: "verdict",
        stationId: event.stationId,
        text: `${vendor} ${decision}`,
        detail:
          findings.length === 0
            ? "no findings"
            : findings
                .map((finding) => `${finding.category}: ${finding.summary}`)
                .join(" · "),
        tone: worst ? "block" : decision === "pass" ? "good" : "warn",
      };
    }
    case "done": {
      const { diff, durationMs, status } = event.result;
      const shape = diff
        ? `${String(diff.filesChanged)} file${diff.filesChanged === 1 ? "" : "s"}, +${String(diff.insertions)} −${String(diff.deletions)}`
        : "no changes";
      return {
        ...base,
        kind: "done",
        stationId: null,
        text: status,
        detail: `${shape} · ${duration(durationMs)}`,
        tone: status === "done" ? "good" : "warn",
      };
    }
    case "error":
      return {
        ...base,
        kind: "error",
        stationId: null,
        text: event.message,
        detail: null,
        tone: "refused",
      };
  }
}

/**
 * One line describing what a tool was actually asked to do.
 *
 * `input` is `unknown` on the wire and comes from a vendor CLI's JSON, so
 * every access here is guarded. A thrown property access inside a render is a
 * blank pane — the same failure Step 40 shipped for a different reason, and
 * the one this file is most exposed to because it is reading somebody else's
 * schema.
 *
 * The fields are the ones the captured streams actually use: `command` for
 * Bash and Codex's shell items, `file_path`/`path` for reads and edits,
 * `pattern` for greps.
 */
export function toolSummary(name: string, input: unknown): string | null {
  if (input === null || typeof input !== "object") {
    return typeof input === "string" && input !== "" ? clip(input) : null;
  }
  const record = input as Record<string, unknown>;
  for (const field of [
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "description",
  ]) {
    const value = record[field];
    if (typeof value === "string" && value !== "") {
      return field === "file_path" || field === "path"
        ? shortPath(value, 3)
        : clip(value);
    }
  }
  // A tool nobody here knows about still deserves a row; it just gets no
  // second line rather than `[object Object]`.
  return name === "" ? null : null;
}

/** Long commands are a paragraph in a log; the first line is the useful part. */
function clip(text: string, limit = 160): string {
  const firstLine = text.split("\n")[0] ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed;
}

function totalsFor(run: Run): RunView["totals"] {
  const total = run.cost.tokensIn + run.cost.tokensOut;
  const diff = run.result?.diff;
  return {
    cost: money(run.cost, run.status),
    tokens: total === 0 ? null : tokens(total),
    duration: run.result === undefined ? null : duration(run.result.durationMs),
    diff:
      diff === undefined
        ? null
        : `${String(diff.filesChanged)} file${diff.filesChanged === 1 ? "" : "s"} · +${String(diff.insertions)} −${String(diff.deletions)}`,
  };
}

/**
 * What a run's *row* says beyond its status — Step 43's clause read literally.
 *
 * "The blocking finding is the thing you see first" is not satisfied by a
 * pane you have to open: the list is what you see before you click, and a row
 * reading only `held` sends you hunting for the reason. `null` for the
 * ordinary run, so the list stays a list.
 */
export function runRowMark(run: Run): { label: string; tone: Tone } | null {
  const blocking = (run.result?.verdicts ?? []).flatMap((verdict) =>
    verdict.findings.filter((finding) => finding.severity === "block"),
  );
  if (blocking.length > 0) {
    return {
      label:
        blocking.length === 1
          ? `blocking: ${blocking[0]?.category ?? ""}`
          : `${String(blocking.length)} blocking findings`,
      tone: "block",
    };
  }
  const held = (run.result?.gates ?? []).find(
    (gate) => gate.outcome === "hold",
  );
  if (held !== undefined) {
    return {
      label:
        held.overridden === true
          ? `overridden: ${held.gate}`
          : `held: ${held.gate}`,
      tone: held.overridden === true ? "warn" : "block",
    };
  }
  return null;
}
