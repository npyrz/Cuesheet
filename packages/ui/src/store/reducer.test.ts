import { describe, expect, it } from "vitest";
import type { Run, RunEvent, RunResultSummary } from "@cuesheet/core";
import {
  activeRun,
  deskReducer,
  initialState,
  selectedEvents,
  selectedRun,
  type DeskAction,
  type DeskState,
} from "./reducer.js";

const AT = "2026-09-10T14:22:33.104Z";

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "20260910T142233104Z-0001",
    kind: "prompt",
    status: "queued",
    prompt: "add rate limiting",
    stationIds: ["opus"],
    workspace: "/tmp/ws",
    createdAt: AT,
    cost: { tokensIn: 0, tokensOut: 0 },
    ...overrides,
  };
}

/** Fold a list of actions, which is how every test below reads. */
function reduce(
  actions: DeskAction[],
  from: DeskState = initialState,
): DeskState {
  return actions.reduce(deskReducer, from);
}

function ev(event: RunEvent): DeskAction {
  return { type: "event", event };
}

const RESULT: RunResultSummary = {
  status: "done",
  cost: { tokensIn: 100, tokensOut: 50, usd: 0.84 },
  durationMs: 1200,
  diff: { filesChanged: 6, insertions: 231, deletions: 18 },
};

describe("connection and errors", () => {
  it("tracks connection status", () => {
    expect(reduce([{ type: "connection", status: "open" }]).connection).toBe(
      "open",
    );
  });

  it("clears an error when told to", () => {
    const state = reduce([
      { type: "error", message: "boom" },
      { type: "error", message: null },
    ]);
    expect(state.error).toBeNull();
  });
});

describe("snapshot", () => {
  it("replaces the run list rather than merging it", () => {
    // The whole reconnect contract rests on this: a merge would resurrect
    // runs the daemon no longer has.
    const first = reduce([{ type: "snapshot", runs: [run({ id: "b" })] }]);
    const second = deskReducer(first, {
      type: "snapshot",
      runs: [run({ id: "a" })],
    });
    expect(second.runs.map((r) => r.id)).toEqual(["a"]);
  });

  it("drops events for runs that are gone", () => {
    const state = reduce([
      ev({ t: "text", at: AT, runId: "gone", stationId: "opus", chunk: "hi" }),
      { type: "snapshot", runs: [run({ id: "kept" })] },
    ]);
    expect(state.events["gone"]).toBeUndefined();
  });

  it("keeps a surviving selection and otherwise falls to the newest run", () => {
    const kept = reduce([
      { type: "snapshot", runs: [run({ id: "b" }), run({ id: "a" })] },
      { type: "select", runId: "a" },
      { type: "snapshot", runs: [run({ id: "b" }), run({ id: "a" })] },
    ]);
    expect(kept.selectedRunId).toBe("a");

    const refalls = deskReducer(kept, {
      type: "snapshot",
      runs: [run({ id: "c" })],
    });
    expect(refalls.selectedRunId).toBe("c");
  });

  it("clears a tile still claiming a run the daemon has since finished", () => {
    // Step 18's done-when in one assertion: restart the daemon mid-run and
    // the UI must correct itself, not keep animating.
    const stale = reduce([
      ev({
        t: "file",
        at: AT,
        runId: "r1",
        stationId: "opus",
        path: "src/x.ts",
        op: "write",
      }),
    ]);
    expect(stale.stationActivity["opus"]?.status).toBe("working");

    const resynced = deskReducer(stale, {
      type: "snapshot",
      runs: [run({ id: "r1", status: "interrupted" })],
    });
    expect(resynced.stationActivity["opus"]).toBeUndefined();
  });

  it("keeps tiles lit for a run that is genuinely still running", () => {
    const state = reduce([
      {
        type: "snapshot",
        runs: [run({ id: "r1", status: "running", stationIds: ["opus"] })],
      },
    ]);
    expect(state.stationActivity["opus"]?.status).toBe("working");
    // But it does not invent a current file it never saw.
    expect(state.stationActivity["opus"]?.currentFile).toBeUndefined();
  });

  it("gives a Station claimed by two live runs to the newer one", () => {
    const state = reduce([
      {
        type: "snapshot",
        runs: [
          run({ id: "b", status: "running", stationIds: ["opus"] }),
          run({ id: "a", status: "running", stationIds: ["opus"] }),
        ],
      },
    ]);
    expect(state.stationActivity["opus"]?.runId).toBe("b");
  });
});

describe("buffered events flushed after a snapshot", () => {
  it("ends up correct regardless of the resync window", () => {
    // The hook attaches the socket, buffers, fetches, snapshots, then flushes.
    // This asserts the flush order actually produces the right state.
    const buffered: RunEvent[] = [
      { t: "status", at: AT, runId: "r1", status: "running" },
      {
        t: "file",
        at: AT,
        runId: "r1",
        stationId: "opus",
        path: "src/limit.ts",
        op: "write",
      },
    ];
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1", status: "queued" })] },
      ...buffered.map(ev),
    ]);

    expect(state.runs[0]?.status).toBe("running");
    expect(state.stationActivity["opus"]?.currentFile).toBe("src/limit.ts");
  });
});

describe("status events", () => {
  it("stamps startedAt once and selects the running run", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1" })] },
      ev({ t: "status", at: AT, runId: "r1", status: "running" }),
      ev({
        t: "status",
        at: "2026-09-10T15:00:00.000Z",
        runId: "r1",
        status: "running",
      }),
    ]);
    expect(state.runs[0]?.startedAt).toBe(AT);
    expect(state.selectedRunId).toBe("r1");
  });

  it("releases tiles on stopped, which arrives without a done event", () => {
    const state = reduce([
      ev({ t: "text", at: AT, runId: "r1", stationId: "opus", chunk: "..." }),
      ev({ t: "status", at: AT, runId: "r1", status: "stopped" }),
    ]);
    expect(state.stationActivity["opus"]?.status).toBe("idle");
    expect(state.stationActivity["opus"]?.endedAt).toBe(AT);
  });

  it("creates a placeholder for a run started by another client", () => {
    // The CLI, or the phone in M3. Dropping these events would animate tiles
    // for a run that never shows up in the list.
    const state = reduce([
      ev({ t: "status", at: AT, runId: "r-elsewhere", status: "running" }),
    ]);
    expect(state.runs.map((r) => r.id)).toEqual(["r-elsewhere"]);
  });

  it("keeps the run list newest-first when it inserts a placeholder", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "20260910T000000000Z-0001" })] },
      ev({
        t: "status",
        at: AT,
        runId: "20260911T000000000Z-0001",
        status: "running",
      }),
    ]);
    expect(state.runs.map((r) => r.id)).toEqual([
      "20260911T000000000Z-0001",
      "20260910T000000000Z-0001",
    ]);
  });
});

describe("station activity", () => {
  it("tracks the current file from file events", () => {
    const state = reduce([
      ev({
        t: "file",
        at: AT,
        runId: "r1",
        stationId: "opus",
        path: "src/a.ts",
        op: "read",
      }),
      ev({
        t: "file",
        at: AT,
        runId: "r1",
        stationId: "opus",
        path: "src/b.ts",
        op: "write",
      }),
    ]);
    expect(state.stationActivity["opus"]?.currentFile).toBe("src/b.ts");
  });

  it("keeps the last non-blank text as the activity line", () => {
    const state = reduce([
      ev({
        t: "text",
        at: AT,
        runId: "r1",
        stationId: "opus",
        chunk: "reading",
      }),
      ev({ t: "text", at: AT, runId: "r1", stationId: "opus", chunk: "   \n" }),
    ]);
    expect(state.stationActivity["opus"]?.lastText).toBe("reading");
  });

  it("resets a tile when a newer run picks the Station up", () => {
    const state = reduce([
      ev({
        t: "file",
        at: AT,
        runId: "r1",
        stationId: "opus",
        path: "old.ts",
        op: "write",
      }),
      ev({
        t: "cost",
        at: AT,
        runId: "r1",
        stationId: "opus",
        tokensIn: 10,
        tokensOut: 5,
        usd: 0.5,
      }),
      ev({
        t: "text",
        at: AT,
        runId: "r2",
        stationId: "opus",
        chunk: "new run",
      }),
    ]);
    const activity = state.stationActivity["opus"];
    expect(activity?.runId).toBe("r2");
    expect(activity?.currentFile).toBeUndefined();
    expect(activity?.cost).toEqual({ tokensIn: 0, tokensOut: 0 });
  });

  it("marks tiles standby and records the ask", () => {
    const state = reduce([
      ev({ t: "text", at: AT, runId: "r1", stationId: "opus", chunk: "..." }),
      ev({
        t: "standby",
        at: AT,
        runId: "r1",
        standbyId: "s1",
        ask: "write outside the leash?",
      }),
    ]);
    expect(state.stationActivity["opus"]?.status).toBe("standby");
    expect(state.standbys.map((s) => s.ask)).toEqual([
      "write outside the leash?",
    ]);
  });

  it("does not duplicate a standby that is re-announced on replay", () => {
    const standby = {
      t: "standby",
      at: AT,
      runId: "r1",
      standbyId: "s1",
      ask: "go?",
    } as const;
    const state = reduce([ev(standby), ev(standby)]);
    expect(state.standbys).toHaveLength(1);
  });
});

describe("cost", () => {
  it("accumulates onto both the tile and the run", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1" })] },
      ev({
        t: "cost",
        at: AT,
        runId: "r1",
        stationId: "opus",
        tokensIn: 100,
        tokensOut: 20,
        usd: 0.5,
      }),
      ev({
        t: "cost",
        at: AT,
        runId: "r1",
        stationId: "opus",
        tokensIn: 50,
        tokensOut: 10,
        usd: 0.34,
      }),
    ]);
    expect(state.runs[0]?.cost.tokensIn).toBe(150);
    expect(state.runs[0]?.cost.tokensOut).toBe(30);
    // Summed as raw floats and rounded only at display time, so this is
    // 0.8400000000000001 and that is the correct thing for it to be.
    expect(state.runs[0]?.cost.usd).toBeCloseTo(0.84, 10);
    expect(state.stationActivity["opus"]?.cost.tokensIn).toBe(150);
  });

  it("leaves usd absent when the harness cannot price it", () => {
    // A local ollama Station reports tokens and no money. Showing $0.00 there
    // is a different claim from showing nothing.
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1" })] },
      ev({
        t: "cost",
        at: AT,
        runId: "r1",
        stationId: "qwen",
        tokensIn: 10,
        tokensOut: 5,
      }),
    ]);
    expect(state.runs[0]?.cost.usd).toBeUndefined();
  });
});

describe("done and error", () => {
  it("lands the result, the totals, and idles the tiles", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1", status: "running" })] },
      ev({ t: "text", at: AT, runId: "r1", stationId: "opus", chunk: "go" }),
      ev({ t: "done", at: AT, runId: "r1", result: RESULT }),
    ]);
    const finished = state.runs[0];
    expect(finished?.status).toBe("done");
    expect(finished?.finishedAt).toBe(AT);
    expect(finished?.result?.diff?.filesChanged).toBe(6);
    expect(finished?.cost.usd).toBe(0.84);
    expect(state.stationActivity["opus"]?.status).toBe("idle");
  });

  it("marks the tile failed when the run failed", () => {
    const state = reduce([
      ev({ t: "text", at: AT, runId: "r1", stationId: "opus", chunk: "go" }),
      ev({
        t: "done",
        at: AT,
        runId: "r1",
        result: { ...RESULT, status: "failed" },
      }),
    ]);
    expect(state.stationActivity["opus"]?.status).toBe("failed");
  });

  it("records an error event on the run and in the header", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1" })] },
      ev({ t: "error", at: AT, runId: "r1", message: "claude exited 1" }),
    ]);
    expect(state.runs[0]?.error).toBe("claude exited 1");
    expect(state.error).toBe("claude exited 1");
  });

  it("keeps a denial in the log without failing the run", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1", status: "running" })] },
      ev({
        t: "denial",
        at: AT,
        runId: "r1",
        reason: "outside the leash",
        path: "/etc/passwd",
      }),
    ]);
    expect(state.runs[0]?.status).toBe("running");
    expect(state.events["r1"]?.some((e) => e.t === "denial")).toBe(true);
  });
});

describe("run-detail", () => {
  it("replaces that run's events and folds them into tiles", () => {
    const events: RunEvent[] = [
      {
        t: "file",
        at: AT,
        runId: "r1",
        stationId: "opus",
        path: "src/x.ts",
        op: "write",
      },
      { t: "done", at: AT, runId: "r1", result: RESULT },
    ];
    const state = reduce([
      {
        type: "run-detail",
        detail: {
          run: run({ id: "r1", status: "done" }),
          events,
          hasDiff: true,
        },
      },
    ]);
    expect(state.events["r1"]).toHaveLength(2);
    // An opened historical run populates tiles the same way a live one does.
    expect(state.stationActivity["opus"]?.currentFile).toBe("src/x.ts");
    expect(state.stationActivity["opus"]?.status).toBe("idle");
  });

  it("does not append the fetched log to a log it already had", () => {
    const detail = {
      run: run({ id: "r1" }),
      events: [
        { t: "text", at: AT, runId: "r1", stationId: "opus", chunk: "a" },
      ] as RunEvent[],
      hasDiff: false,
    };
    const state = reduce([
      { type: "run-detail", detail },
      { type: "run-detail", detail },
    ]);
    expect(state.events["r1"]).toHaveLength(1);
  });
});

describe("selectors", () => {
  it("resolve the selected run and its events", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "r1" })] },
      ev({ t: "text", at: AT, runId: "r1", stationId: "opus", chunk: "hi" }),
      { type: "select", runId: "r1" },
    ]);
    expect(selectedRun(state)?.id).toBe("r1");
    expect(selectedEvents(state)).toHaveLength(1);
  });

  it("find the one non-terminal run", () => {
    const state = reduce([
      {
        type: "snapshot",
        runs: [
          run({ id: "b", status: "done" }),
          run({ id: "a", status: "running" }),
        ],
      },
    ]);
    expect(activeRun(state)?.id).toBe("a");
  });

  it("report no active run when everything is terminal", () => {
    const state = reduce([
      { type: "snapshot", runs: [run({ id: "a", status: "done" })] },
    ]);
    expect(activeRun(state)).toBeNull();
  });
});
