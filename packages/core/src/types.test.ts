import { describe, expect, it } from "vitest";
import {
  RUN_EVENT_TYPES,
  ROLES,
  TERMINAL_RUN_STATUSES,
  isTerminalStatus,
  type RunEvent,
  type RunEventType,
  type RunStatus,
} from "./types.js";

/**
 * One of each variant. Typed as `RunEvent[]`, so this array *is* the
 * compile-time half of the check: a variant whose shape drifts, or that stops
 * carrying `runId`/`at`, fails to typecheck here before any assertion runs.
 */
const sample: RunEvent[] = [
  {
    t: "status",
    at: "2026-09-09T12:00:00.000Z",
    runId: "r1",
    status: "running",
  },
  {
    t: "text",
    at: "2026-09-09T12:00:01.000Z",
    runId: "r1",
    stationId: "opus",
    chunk: "hi",
  },
  {
    t: "tool",
    at: "2026-09-09T12:00:02.000Z",
    runId: "r1",
    stationId: "opus",
    name: "bash",
    input: { cmd: "ls" },
  },
  {
    t: "file",
    at: "2026-09-09T12:00:03.000Z",
    runId: "r1",
    stationId: "opus",
    path: "src/a.ts",
    op: "write",
  },
  {
    t: "standby",
    at: "2026-09-09T12:00:04.000Z",
    runId: "r1",
    standbyId: "s1",
    ask: "Write to infra/?",
  },
  {
    t: "denial",
    at: "2026-09-09T12:00:05.000Z",
    runId: "r1",
    reason: "denied by leash",
    path: ".env",
  },
  {
    t: "cost",
    at: "2026-09-09T12:00:06.000Z",
    runId: "r1",
    stationId: "opus",
    tokensIn: 10,
    tokensOut: 20,
  },
  {
    t: "verdict",
    at: "2026-09-09T12:00:06.500Z",
    runId: "r1",
    stationId: "codex",
    verdict: {
      id: "v1",
      runId: "r1",
      stationId: "codex",
      harness: "codex",
      vendor: "OpenAI",
      decision: "fail",
      findings: [
        {
          category: "security",
          severity: "block",
          summary: "The upload endpoint still trusts the client's filename.",
        },
      ],
      at: "2026-09-09T12:00:06.500Z",
    },
  },
  {
    t: "done",
    at: "2026-09-09T12:00:07.000Z",
    runId: "r1",
    result: {
      status: "done",
      cost: { tokensIn: 10, tokensOut: 20 },
      durationMs: 7000,
    },
  },
  { t: "error", at: "2026-09-09T12:00:08.000Z", runId: "r1", message: "boom" },
];

describe("RunEvent", () => {
  it("covers every declared event type exactly once", () => {
    expect(sample.map((e) => e.t).sort()).toEqual([...RUN_EVENT_TYPES].sort());
  });

  it("carries runId and a UTC ISO 8601 timestamp on every variant", () => {
    for (const event of sample) {
      expect(event.runId, event.t).toBeTruthy();
      expect(event.at, event.t).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
      expect(new Date(event.at).toISOString(), event.t).toBe(event.at);
    }
  });

  it("narrows exhaustively on the discriminant", () => {
    // The `never` fallthrough is the real assertion: adding a variant without
    // handling it here becomes a compile error, not a silently ignored event.
    const describeEvent = (event: RunEvent): string => {
      switch (event.t) {
        case "status":
          return event.status;
        case "text":
          return event.chunk;
        case "tool":
          return event.name;
        case "file":
          return event.op;
        case "standby":
          return event.ask;
        case "denial":
          return event.reason;
        case "cost":
          return String(event.tokensIn);
        case "verdict":
          return event.verdict.decision;
        case "done":
          return event.result.status;
        case "error":
          return event.message;
        default: {
          const unreachable: never = event;
          return unreachable;
        }
      }
    };

    expect(sample.map(describeEvent)).toHaveLength(RUN_EVENT_TYPES.length);
  });
});

describe("vocabulary", () => {
  it("matches the README's four roles", () => {
    expect(ROLES).toEqual(["engineer", "reviewer", "worker", "caller"]);
  });

  it("treats every outcome as terminal, including a Hold", () => {
    for (const status of TERMINAL_RUN_STATUSES) {
      expect(isTerminalStatus(status), status).toBe(true);
    }
    // Only these three have something still to happen. This test used to
    // include `held`, on the reading that a Hold waits for a human — it does,
    // but it waits as a *standby*, before the run ends. By the time a run
    // reads `held`, the Gate has asked and a human has answered "no": nothing
    // is pending, and releasing a Hold is a new run rather than a resumption
    // of this one. See the comment on TERMINAL_RUN_STATUSES.
    const pending: RunStatus[] = ["queued", "running", "standby"];
    for (const status of pending) {
      expect(isTerminalStatus(status), status).toBe(false);
    }
  });

  it("keeps RUN_EVENT_TYPES aligned with the union", () => {
    const t: RunEventType = "done";
    expect(RUN_EVENT_TYPES).toContain(t);
  });
});
