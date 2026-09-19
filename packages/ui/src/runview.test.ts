import { describe, expect, it } from "vitest";
import type { Run, RunEvent, RunId, Verdict } from "@cuesheet/core";
import { phase7GateRun } from "./fixtures/gate-run.js";
import {
  deskReducer,
  initialState,
  selectedEvents,
  selectedRun,
} from "./store/reducer.js";
import {
  describeRun,
  runRowMark,
  timelineFrom,
  toolSummary,
} from "./runview.js";

const RUN_ID = "20260916T120000000Z-0001" as RunId;
const AT = "2026-09-16T12:00:00.000Z";

function run(over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    kind: "prompt",
    status: "running",
    prompt: "add rate limiting",
    stationIds: ["opus"],
    workspace: "/ws",
    createdAt: AT,
    cost: { tokensIn: 0, tokensOut: 0 },
    ...over,
  };
}

function verdict(over: Partial<Verdict> = {}): Verdict {
  return {
    id: "v1",
    runId: RUN_ID,
    stationId: "gpt",
    harness: "codex",
    vendor: "openai",
    decision: "pass",
    findings: [],
    at: AT,
    ...over,
  };
}

/**
 * The step's own done-when, and the reason this fixture exists.
 *
 * It replays through the *reducer* rather than being handed to `describeRun`
 * directly, because that is the path a real run takes: events arrive on the
 * socket, the reducer folds them, and the surface renders what the reducer
 * holds. A test that skipped it would prove the formatter and not the app.
 */
describe("the Phase 7 gate run, replayed", () => {
  const replay = () => {
    const { run: record, events } = phase7GateRun();
    let state = deskReducer(initialState, { type: "snapshot", runs: [record] });
    for (const event of events)
      state = deskReducer(state, { type: "event", event });
    const selected = selectedRun(state);
    expect(selected).not.toBeNull();
    return describeRun(selected as Run, selectedEvents(state));
  };

  it("leads with the blocking finding, not with the status", () => {
    const view = replay();
    expect(view.headline?.kind).toBe("blocking");
    expect(view.headline?.lines[0]).toContain("unbounded memory growth");
    expect(view.headline?.tone).toBe("block");
  });

  it("leads with it even though the reviewer's decision was a pass", () => {
    // The recorded run really is this shape, and it is the case a surface
    // keyed on `decision` draws green over a security hole.
    const view = replay();
    expect(view.findings[0]?.severity).toBe("block");
    expect(view.timeline.find((entry) => entry.kind === "verdict")?.tone).toBe(
      "block",
    );
  });

  it("puts the finding above the whole timeline", () => {
    // "Seen first" is a claim about position, so it is asserted as one: the
    // headline exists, and the finding is not something you reach by scrolling
    // a log of fifteen events.
    const view = replay();
    expect(view.headline).not.toBeNull();
    expect(view.timeline.length).toBeGreaterThan(5);
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]?.where).toBe("upload.js:14");
  });

  it("keeps the gate's own reasons, both of them", () => {
    const view = replay();
    expect(view.gates).toHaveLength(1);
    expect(view.gates[0]).toMatchObject({
      gate: "default",
      outcome: "hold",
      tone: "block",
    });
    expect(view.gates[0]?.reasons).toEqual([
      "1 blocking finding (security).",
      "0 of 1 required approval (1 review recorded).",
    ]);
  });

  it("does not merge the reviewer's prose into the engineer's", () => {
    const view = replay();
    const prose = view.timeline.filter((entry) => entry.kind === "text");
    expect(prose).toHaveLength(2);
    expect(prose[0]).toMatchObject({
      stationId: "opus",
      text: "Reading upload.js to find the endpoint.",
    });
    expect(prose[1]).toMatchObject({
      stationId: "gpt",
      text: "Reviewing the diff.",
    });
  });

  it("carries the run's numbers into the header rather than the log", () => {
    const view = replay();
    expect(view.totals).toEqual({
      cost: "$0.56",
      tokens: "44.4k",
      duration: "2m51s",
      diff: "1 file · +22 −1",
    });
    expect(
      view.timeline.some((entry) => entry.kind === ("cost" as never)),
    ).toBe(false);
  });

  it("marks the run's row, because the list is what you see before the pane", () => {
    const { run: record } = phase7GateRun();
    expect(runRowMark(record)).toEqual({
      label: "blocking: security",
      tone: "block",
    });
  });
});

describe("what the surface leads with", () => {
  it("says nothing at all for an ordinary running run", () => {
    // A surface that announces every state teaches people to skip the
    // announcement.
    const view = describeRun(run(), []);
    expect(view.headline).toBeNull();
    expect(view.findings).toEqual([]);
    expect(view.gates).toEqual([]);
  });

  it("prefers a blocking finding over a failure message", () => {
    const view = describeRun(
      run({
        status: "held",
        error: "Gate held this run.",
        result: {
          status: "held",
          cost: { tokensIn: 1, tokensOut: 1 },
          durationMs: 1000,
          verdicts: [
            verdict({
              findings: [
                {
                  category: "security",
                  severity: "block",
                  summary: "leaks credentials",
                },
              ],
            }),
          ],
        },
      }),
      [],
    );
    expect(view.headline?.kind).toBe("blocking");
    expect(view.headline?.lines[0]).toContain("leaks credentials");
  });

  it("falls back to the error when no finding explains it", () => {
    const view = describeRun(
      run({ status: "failed", error: "claude exited 1" }),
      [],
    );
    expect(view.headline).toMatchObject({ kind: "error", tone: "refused" });
  });

  it("leads with the question while a run is waiting on a human", () => {
    const events: RunEvent[] = [
      {
        t: "standby",
        at: AT,
        runId: RUN_ID,
        standbyId: "sb",
        ask: "Write the file?",
      },
    ];
    const view = describeRun(run({ status: "standby" }), events);
    expect(view.headline).toMatchObject({ kind: "standby", tone: "warn" });
    expect(view.headline?.lines).toEqual(["Write the file?"]);
  });

  it("does not lead with a standby the run has moved past", () => {
    // The event stays in the log after it is answered; the run's status is
    // what says whether anybody is still waiting.
    const events: RunEvent[] = [
      {
        t: "standby",
        at: AT,
        runId: RUN_ID,
        standbyId: "sb",
        ask: "Write the file?",
      },
    ];
    expect(describeRun(run({ status: "running" }), events).headline).toBeNull();
  });

  /**
   * Found by driving a real two-vendor gate run: `Finding.severity` is the
   * reviewer's judgement, while a Gate holds on its configured `blocking`
   * *categories*. A reviewer can flag `severity: "block"` in a category no
   * Gate names, and the run finishes clean — and a headline implying a hold
   * that never happened is a surface nobody should trust twice.
   */
  it("does not imply a hold when nothing actually stopped the run", () => {
    const view = describeRun(
      run({
        status: "done",
        result: {
          status: "done",
          cost: { tokensIn: 1, tokensOut: 1 },
          durationMs: 1,
          gates: [{ gate: "default", outcome: "pass", reasons: [] }],
          verdicts: [
            verdict({
              findings: [
                {
                  category: "security",
                  severity: "block",
                  summary: "logs the key",
                },
              ],
            }),
          ],
        },
      }),
      [],
    );
    expect(view.headline?.kind).toBe("blocking");
    expect(view.headline?.title).toContain("nothing stopped this run");
    expect(view.headline?.tone).toBe("warn");
    // The finding is still the thing you read first.
    expect(view.headline?.lines[0]).toContain("logs the key");
  });

  it("does not tell a live run that nothing stopped it", () => {
    // A run sitting on a Hold's standby has a verdict and no gate report —
    // the gate's record does not exist until the run ends. Telling it that
    // nothing stopped it, while it waits to be answered, is the opposite of
    // what is happening.
    const view = describeRun(run({ status: "running" }), [
      {
        t: "verdict",
        at: AT,
        runId: RUN_ID,
        stationId: "gpt",
        verdict: verdict({
          findings: [
            {
              category: "security",
              severity: "block",
              summary: "logs the key",
            },
          ],
        }),
      },
    ]);
    expect(view.headline?.title).toBe("A reviewer filed a blocking finding.");
    expect(view.headline?.tone).toBe("block");
  });

  it("counts two blocking findings as two", () => {
    const view = describeRun(
      run({
        result: {
          status: "held",
          cost: { tokensIn: 1, tokensOut: 1 },
          durationMs: 1,
          verdicts: [
            verdict({
              findings: [
                { category: "security", severity: "block", summary: "a" },
                { category: "correctness", severity: "block", summary: "b" },
                { category: "style", severity: "info", summary: "c" },
              ],
            }),
          ],
        },
      }),
      [],
    );
    expect(view.headline?.title).toContain("2 blocking findings");
    // The info finding is still listed — just not led with.
    expect(view.findings.map((f) => f.severity)).toEqual([
      "block",
      "block",
      "info",
    ]);
  });

  it("does not draw an overridden hold as a pass", () => {
    const view = describeRun(
      run({
        status: "done",
        result: {
          status: "done",
          cost: { tokensIn: 1, tokensOut: 1 },
          durationMs: 1,
          gates: [
            {
              gate: "default",
              outcome: "hold",
              overridden: true,
              reasons: ["waved through"],
            },
          ],
        },
      }),
      [],
    );
    expect(view.gates[0]).toMatchObject({ overridden: true, tone: "warn" });
    expect(view.headline).toBeNull();
    expect(
      runRowMark(
        view.gates.length > 0
          ? run({
              result: {
                status: "done",
                cost: { tokensIn: 1, tokensOut: 1 },
                durationMs: 1,
                gates: [
                  {
                    gate: "default",
                    outcome: "hold",
                    overridden: true,
                    reasons: [],
                  },
                ],
              },
            })
          : run(),
      ),
    ).toMatchObject({ tone: "warn" });
  });

  it("does not count the same verdict twice when it arrives by both routes", () => {
    // A run opened from the list has its verdicts on the record *and* in the
    // log the resync fetched. Double-counting them is how a headline's number
    // stops being believed.
    const filed = verdict({
      findings: [
        {
          category: "security",
          severity: "block",
          summary: "leaks credentials",
        },
      ],
    });
    const view = describeRun(
      run({
        result: {
          status: "held",
          cost: { tokensIn: 1, tokensOut: 1 },
          durationMs: 1,
          verdicts: [filed],
        },
      }),
      [
        {
          t: "verdict",
          at: AT,
          runId: RUN_ID,
          stationId: "gpt",
          verdict: filed,
        },
      ],
    );
    expect(view.findings).toHaveLength(1);
    expect(view.headline?.title).toContain("a blocking finding");
  });
});

describe("the timeline", () => {
  it("keeps a denial, and does not dress it as an error", () => {
    // The only visible evidence that a boundary held.
    const [entry] = timelineFrom([
      {
        t: "denial",
        at: AT,
        runId: RUN_ID,
        reason: 'Denied by leash rule "infra/**".',
        path: "/ws/infra/main.tf",
      },
    ]);
    expect(entry).toMatchObject({
      kind: "denial",
      tone: "refused",
      detail: "ws/infra/main.tf",
    });
  });

  it("resumes a paragraph after a tool call rather than appending to it", () => {
    const entries = timelineFrom([
      { t: "text", at: AT, runId: RUN_ID, stationId: "opus", chunk: "First. " },
      {
        t: "tool",
        at: AT,
        runId: RUN_ID,
        stationId: "opus",
        name: "Bash",
        input: { command: "ls" },
      },
      { t: "text", at: AT, runId: RUN_ID, stationId: "opus", chunk: "Second." },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "text",
      "tool",
      "text",
    ]);
    expect(entries[0]?.text).toBe("First.");
    expect(entries[2]?.text).toBe("Second.");
  });

  it("does not let a cost event break a paragraph", () => {
    // Found by watching a real run: costs arrive between sentences, and a
    // paragraph split by an event nobody renders is chrome with no cause on
    // screen.
    const entries = timelineFrom([
      {
        t: "text",
        at: AT,
        runId: RUN_ID,
        stationId: "opus",
        chunk: "Planning the change. ",
      },
      {
        t: "cost",
        at: AT,
        runId: RUN_ID,
        stationId: "opus",
        tokensIn: 10,
        tokensOut: 2,
      },
      {
        t: "text",
        at: AT,
        runId: RUN_ID,
        stationId: "opus",
        chunk: "Editing one file.",
      },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("Planning the change. Editing one file.");
  });

  it("drops a chunk that was only whitespace", () => {
    expect(
      timelineFrom([
        { t: "text", at: AT, runId: RUN_ID, stationId: "opus", chunk: "\n\n" },
      ]),
    ).toEqual([]);
  });

  it("says what a write touched", () => {
    const [entry] = timelineFrom([
      {
        t: "file",
        at: AT,
        runId: RUN_ID,
        stationId: "opus",
        path: "/ws/src/upload.js",
        op: "write",
      },
    ]);
    expect(entry).toMatchObject({
      text: "wrote",
      detail: "ws/src/upload.js",
      tone: "good",
    });
  });
});

describe("toolSummary", () => {
  it("reads the fields the real captures use", () => {
    expect(toolSummary("Bash", { command: "npm test" })).toBe("npm test");
    expect(toolSummary("Read", { file_path: "/a/b/c/d.ts" })).toBe(
      "…/b/c/d.ts",
    );
    expect(toolSummary("Grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("takes the first line of a multi-line command", () => {
    expect(toolSummary("shell", { command: "git diff --stat\ngit diff" })).toBe(
      "git diff --stat",
    );
  });

  it("clips something long enough to be a paragraph", () => {
    const summary = toolSummary("Bash", { command: "x".repeat(400) });
    expect(summary?.length).toBeLessThanOrEqual(160);
    expect(summary?.endsWith("…")).toBe(true);
  });

  it("survives whatever a vendor actually sends", () => {
    // `input` is `unknown` on the wire and comes from somebody else's JSON. A
    // thrown property access inside a render is a blank pane.
    for (const input of [
      null,
      undefined,
      42,
      [],
      {},
      { command: 7 },
      { file_path: "" },
    ]) {
      expect(() => toolSummary("Tool", input)).not.toThrow();
    }
    expect(toolSummary("Tool", { command: 7 })).toBeNull();
    expect(toolSummary("Tool", "inline string")).toBe("inline string");
  });
});
