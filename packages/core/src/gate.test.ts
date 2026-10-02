import { describe, expect, it } from "vitest";
import type { Finding, Verdict } from "./types.js";
import type { Gate } from "./config.js";
import { GateSchema } from "./config.js";
import {
  describeGate,
  evaluateGate,
  gateSkip,
  neverReviewRule,
  parseRequire,
  type GateParticipant,
} from "./gate.js";
import type { ChangedFile } from "./brief.js";
import type { HostEnv } from "./paths.js";

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

describe("path rules", () => {
  const POSIX: HostEnv = { platform: "darwin", homedir: "/Users/op" };
  const WINDOWS: HostEnv = { platform: "win32", homedir: "C:/Users/op" };

  function file(path: string, lines: number): ChangedFile {
    return { path, insertions: lines, deletions: 0 };
  }

  function changes(files: ChangedFile[], env: HostEnv = POSIX) {
    return {
      verdicts: [],
      participants: [ANTHROPIC],
      diff: {
        filesChanged: files.length,
        insertions: files.reduce((sum, f) => sum + f.insertions, 0),
        deletions: 0,
      },
      changes: { files, env },
    };
  }

  it("skips a lockfile-only change on a path rule, not a line count", () => {
    // Forty thousand lines, no `skip_if_diff_under` at all. Only the path
    // rule can skip this, and it does.
    const rules = gate({ never_review: ["**/package-lock.json"] });
    const result = evaluateGate(
      rules,
      changes([file("package-lock.json", 40_000)]),
    );
    expect(result.outcome).toBe("skipped");
    expect(result.reasons[0]).toContain("never_review");
    expect(result.reasons[0]).toContain("package-lock.json");
  });

  it("reviews a five-line auth change that the line count would wave through", () => {
    const rules = gate({
      skip_if_diff_under: 20,
      always_review: ["src/auth/**"],
    });
    const input = changes([file("src/auth/session.ts", 5)]);
    expect(gateSkip(rules, input)).toBeNull();
    expect(evaluateGate(rules, input).outcome).toBe("hold");
  });

  it("does not count never_review lines toward skip_if_diff_under", () => {
    // A three-line fix that also churned the lockfile is a three-line fix.
    const rules = gate({
      skip_if_diff_under: 20,
      never_review: ["package-lock.json"],
    });
    const reason = gateSkip(
      rules,
      changes([file("package-lock.json", 5_000), file("src/a.ts", 3)]),
    );
    expect(reason).toBe(
      "Diff is 3 lines outside never_review paths, under the gate's threshold of 20.",
    );
  });

  it("does not skip a mixed change on the path rule alone", () => {
    const rules = gate({ never_review: ["package-lock.json"] });
    expect(
      gateSkip(
        rules,
        changes([file("package-lock.json", 1), file("src/a.ts", 1)]),
      ),
    ).toBeNull();
  });

  it("lets always_review beat never_review on the same file", () => {
    // Two rules disagreeing is a config mistake, and the safe reading of a
    // mistake in a safety check is to look.
    const rules = gate({
      always_review: ["infra/**"],
      never_review: ["**/*.json"],
    });
    expect(neverReviewRule(rules, "infra/policy.json", POSIX)).toBeUndefined();
    expect(gateSkip(rules, changes([file("infra/policy.json", 1)]))).toBeNull();
  });

  it("folds case on Windows and only there, exactly as the leash does", () => {
    const rules = gate({
      always_review: ["src/auth/**"],
      skip_if_diff_under: 20,
    });
    const shouted = [file("SRC/Auth/session.ts", 1)];
    expect(gateSkip(rules, changes(shouted, WINDOWS))).toBeNull();
    expect(gateSkip(rules, changes(shouted, POSIX))).not.toBeNull();
  });

  it("does not skip an empty diff on a path rule — there is nothing to say", () => {
    const rules = gate({ never_review: ["**/*.lock"] });
    expect(gateSkip(rules, changes([]))).toBeNull();
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
