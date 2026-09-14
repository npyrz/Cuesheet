import { describe, expect, it } from "vitest";
import type { Finding, Verdict } from "./types.js";
import type { Gate } from "./config.js";
import { GateSchema } from "./config.js";
import {
  describeGate,
  evaluateGate,
  parseRequire,
  type GateParticipant,
} from "./gate.js";

/** Parsed through the schema, so defaults are the ones a user would get. */
function gate(overrides: Record<string, unknown> = {}): Gate {
  return GateSchema.parse(overrides);
}

const ANTHROPIC: GateParticipant = {
  stationId: "opus",
  harness: "claude-code",
  vendor: "Anthropic",
};
const OPENAI: GateParticipant = {
  stationId: "codex",
  harness: "codex",
  vendor: "OpenAI",
};

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    id: "v1",
    runId: "r1",
    stationId: "codex",
    harness: "codex",
    vendor: "OpenAI",
    decision: "pass",
    findings: [],
    at: "2026-09-11T10:00:00.000Z",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    category: "security",
    severity: "block",
    summary: "The upload endpoint trusts the client's filename.",
    ...overrides,
  };
}

describe("parseRequire", () => {
  it("reads the README's forms", () => {
    expect(parseRequire("1-of-1")).toEqual({ required: 1, of: 1 });
    expect(parseRequire("2-of-3")).toEqual({ required: 2, of: 3 });
  });

  it("falls back to 1-of-1 on nonsense rather than throwing", () => {
    // The schema already rejects malformed values at parse time, so reaching
    // here means something built a Gate by hand. A gate is a safety check:
    // the failure mode has to be "require an approval", never "require none".
    expect(parseRequire("everyone")).toEqual({ required: 1, of: 1 });
  });
});

describe("evaluateGate", () => {
  it("passes the README's own example", () => {
    // `require = "1-of-1"` with `distinct_vendors = 2`: one reviewer, and the
    // second vendor is the engineer under review. If this ever fails, the
    // shipped config example fails its own gate.
    const result = evaluateGate(
      gate({
        require: "1-of-1",
        distinct_vendors: 2,
        blocking: ["security", "correctness"],
      }),
      { verdicts: [verdict()], participants: [ANTHROPIC, OPENAI] },
    );

    expect(result.outcome).toBe("pass");
    expect(result.reasons).toEqual([]);
    expect(result.vendors).toEqual(["Anthropic", "OpenAI"]);
  });

  it("holds when the only reviewer shares the author's vendor", () => {
    // The whole thesis in one assertion: a model reviewing its own work is
    // not a second opinion, however enthusiastically it approves.
    const result = evaluateGate(gate({ distinct_vendors: 2 }), {
      verdicts: [verdict({ stationId: "sonnet", vendor: "Anthropic" })],
      participants: [
        ANTHROPIC,
        { stationId: "sonnet", harness: "claude-code", vendor: "Anthropic" },
      ],
    });

    expect(result.outcome).toBe("hold");
    expect(result.reasons.join(" ")).toContain("1 vendor");
  });

  it("treats an abstention as a failure, not a pass by absence", () => {
    // The single test that decides whether this feature is real: a reviewer
    // whose output could not be read as a verdict has approved nothing.
    const result = evaluateGate(gate({ require: "1-of-1" }), {
      verdicts: [verdict({ decision: "abstain" })],
      participants: [ANTHROPIC, OPENAI],
    });

    expect(result.outcome).toBe("hold");
    expect(result.reasons.join(" ")).toContain("0 of 1 required approval");
  });

  it("holds a run with no reviews at all", () => {
    const result = evaluateGate(gate(), {
      verdicts: [],
      participants: [ANTHROPIC],
    });
    expect(result.outcome).toBe("hold");
  });

  it("holds on a blocking finding even when the reviewer passed it", () => {
    // "Looks fine, but this leaks the key." The category wins over the mood.
    const result = evaluateGate(gate({ blocking: ["security"] }), {
      verdicts: [verdict({ decision: "pass", findings: [finding()] })],
      participants: [ANTHROPIC, OPENAI],
    });

    expect(result.outcome).toBe("hold");
    expect(result.blocking).toHaveLength(1);
    expect(result.reasons.join(" ")).toContain("blocking finding");
  });

  it("lets a finding through when its category is not blocking", () => {
    const result = evaluateGate(gate({ blocking: ["security"] }), {
      verdicts: [
        verdict({
          findings: [finding({ category: "style", severity: "warn" })],
        }),
      ],
      participants: [ANTHROPIC, OPENAI],
    });

    expect(result.outcome).toBe("pass");
    expect(result.blocking).toEqual([]);
  });

  it("counts approvals against `require`", () => {
    const two = [verdict({ id: "v1" }), verdict({ id: "v2" })];
    const gate23 = gate({ require: "2-of-3", distinct_vendors: 1 });

    expect(
      evaluateGate(gate23, { verdicts: two, participants: [OPENAI] }).outcome,
    ).toBe("pass");
    expect(
      evaluateGate(gate23, {
        verdicts: [two[0]!, verdict({ id: "v3", decision: "fail" })],
        participants: [OPENAI],
      }).outcome,
    ).toBe("hold");
  });

  it("skips a change too small to be worth reviewing", () => {
    const result = evaluateGate(gate({ skip_if_diff_under: 20 }), {
      verdicts: [],
      participants: [ANTHROPIC],
      diff: { filesChanged: 1, insertions: 3, deletions: 1 },
    });

    expect(result.outcome).toBe("skipped");
    expect(result.reasons.join(" ")).toContain("4 lines");
  });

  it("does not skip once the change is big enough", () => {
    const result = evaluateGate(gate({ skip_if_diff_under: 20 }), {
      verdicts: [],
      participants: [ANTHROPIC],
      diff: { filesChanged: 2, insertions: 30, deletions: 0 },
    });

    expect(result.outcome).toBe("hold");
  });

  it("does not skip when the diff is unknown", () => {
    // No diff is not a small diff. Defaulting to "skip" here would turn a
    // failure to compute the diff into a gate that silently never runs.
    const result = evaluateGate(gate({ skip_if_diff_under: 20 }), {
      verdicts: [],
      participants: [ANTHROPIC],
    });

    expect(result.outcome).toBe("hold");
  });

  it("reports every reason, not just the first", () => {
    // The standby has to say everything that is wrong: fixing one reason and
    // being held again by the next is how people learn to resent a gate.
    const result = evaluateGate(
      gate({ require: "2-of-2", distinct_vendors: 2, blocking: ["security"] }),
      {
        verdicts: [verdict({ decision: "fail", findings: [finding()] })],
        participants: [OPENAI],
      },
    );

    expect(result.outcome).toBe("hold");
    expect(result.reasons).toHaveLength(3);
  });
});

describe("describeGate", () => {
  it("says what happened in the words the run record will carry", () => {
    const held = evaluateGate(gate({ distinct_vendors: 2 }), {
      verdicts: [],
      participants: [ANTHROPIC],
    });
    expect(describeGate("default", held)).toMatch(
      /^Gate "default" held this run\./,
    );

    const passed = evaluateGate(gate(), {
      verdicts: [verdict()],
      participants: [ANTHROPIC, OPENAI],
    });
    expect(describeGate("default", passed)).toBe('Gate "default" passed.');
  });
});
