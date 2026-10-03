import { describe, expect, it } from "vitest";
import {
  buildContextAudit,
  observedRates,
  type ContextSource,
} from "./context.js";
import { buildLedger } from "./ledger.js";
import type { Run } from "./types.js";

function source(
  id: string,
  bytes: number,
  overrides: Partial<ContextSource> = {},
): ContextSource {
  const [scope, path] = id.split(":") as ["project" | "user", string];
  return {
    id,
    kind: "file",
    scope,
    path,
    exists: bytes > 0,
    bytes,
    generatedBytes: 0,
    ...overrides,
  };
}

/** One run in which `opus` (anthropic) spent 1M input tokens for $3. */
function pricedLedger() {
  const cost = { tokensIn: 1_000_000, tokensOut: 0, usd: 3 };
  const run: Run = {
    id: "r1",
    kind: "prompt",
    status: "done",
    prompt: "p",
    stationIds: ["opus"],
    workspace: "/ws",
    createdAt: "2026-10-01T10:00:00Z",
    cost,
    result: {
      status: "done",
      durationMs: 1,
      cost,
      stations: [
        {
          stationId: "opus",
          harness: "claude-code",
          vendor: "anthropic",
          cost,
        },
      ],
    },
  };
  return buildLedger([run, { ...run, id: "r2" }]);
}

describe("buildContextAudit", () => {
  it("multiplies a file by every Station that loads it", () => {
    const audit = buildContextAudit({
      sources: [source("project:CLAUDE.md", 4_000)],
      stations: [
        {
          id: "opus",
          harness: "claude-code",
          loads: ["project:CLAUDE.md"],
        },
        {
          id: "sonnet",
          harness: "claude-code",
          loads: ["project:CLAUDE.md"],
        },
      ],
    });
    expect(audit.files[0]).toMatchObject({
      estimatedTokens: 1_000,
      loadedBy: ["opus", "sonnet"],
      perRunTokens: 2_000,
    });
    expect(audit.perRun.estimatedTokens).toBe(2_000);
  });

  /**
   * The step's second done-when clause, at the arithmetic level: the same
   * file 40,000 bytes larger is 10,000 more tokens *and a price*, not just a
   * bigger number of bytes.
   */
  it("prices 10k more tokens as a cost change", () => {
    const stations = [
      {
        id: "opus",
        harness: "claude-code",
        vendor: "anthropic",
        loads: ["project:CLAUDE.md"],
      },
    ];
    const ledger = pricedLedger();
    const before = buildContextAudit({
      sources: [source("project:CLAUDE.md", 8_000)],
      stations,
      ledger,
    });
    const after = buildContextAudit({
      sources: [source("project:CLAUDE.md", 48_000)],
      stations,
      ledger,
    });
    expect(after.perRun.estimatedTokens - before.perRun.estimatedTokens).toBe(
      10_000,
    );
    // $3 per million input tokens observed, so 10k tokens is three cents.
    expect((after.perRun.usd ?? 0) - (before.perRun.usd ?? 0)).toBeCloseTo(
      0.03,
      10,
    );
    // And over the two runs already on the ledger, at today's size.
    expect(after.history.runs).toBe(2);
    expect(after.history.estimatedTokens).toBe(24_000);
    expect(after.history.usd).toBeCloseTo(0.072, 10);
  });

  it("does not price a Station whose vendor the ledger never priced", () => {
    const audit = buildContextAudit({
      sources: [source("project:AGENTS.md", 400)],
      stations: [
        {
          id: "gpt",
          harness: "codex",
          vendor: "openai",
          loads: ["project:AGENTS.md"],
        },
      ],
      ledger: pricedLedger(),
    });
    expect(audit.perRun.usd).toBeUndefined();
    expect(audit.perRun.unpriced).toEqual(["gpt"]);
    expect(audit.stations[0]?.usdPerRun).toBeUndefined();
  });

  it("does not call a Station with no context unpriced", () => {
    const audit = buildContextAudit({
      sources: [source("project:AGENTS.md", 0)],
      stations: [
        {
          id: "gpt",
          harness: "codex",
          vendor: "openai",
          loads: ["project:AGENTS.md"],
        },
      ],
    });
    expect(audit.perRun.unpriced).toEqual([]);
    expect(audit.perRun.estimatedTokens).toBe(0);
  });

  it("reports an unknown harness as unknown, not as free", () => {
    const audit = buildContextAudit({
      sources: [],
      stations: [{ id: "x", harness: "someone-elses", loads: null }],
    });
    expect(audit.stations[0]).toMatchObject({
      known: false,
      estimatedTokens: 0,
    });
  });

  it("splits the generated block out of a file's size", () => {
    const audit = buildContextAudit({
      sources: [source("project:CLAUDE.md", 4_000, { generatedBytes: 1_000 })],
      stations: [],
    });
    expect(audit.files[0]).toMatchObject({
      estimatedTokens: 1_000,
      generatedTokens: 250,
      perRunTokens: 0,
    });
  });

  it("orders files by what they cost a run, then by id", () => {
    const audit = buildContextAudit({
      sources: [
        source("user:.claude/CLAUDE.md", 400),
        source("project:MOCK.md", 0),
        source("project:CLAUDE.md", 400),
        source("project:AGENTS.md", 4_000),
      ],
      stations: [
        {
          id: "a",
          harness: "claude-code",
          loads: ["user:.claude/CLAUDE.md", "project:CLAUDE.md"],
        },
        { id: "b", harness: "codex", loads: ["project:AGENTS.md"] },
      ],
    });
    expect(audit.files.map((file) => file.id)).toEqual([
      "project:AGENTS.md",
      "project:CLAUDE.md",
      "user:.claude/CLAUDE.md",
      "project:MOCK.md",
    ]);
    expect(audit.stations[0]?.files).toEqual([
      "project:CLAUDE.md",
      "user:.claude/CLAUDE.md",
    ]);
  });
});

describe("observedRates", () => {
  it("is dollars per input token over each priced vendor", () => {
    expect(observedRates(pricedLedger())).toEqual([
      { vendor: "anthropic", usdPerInputToken: 3 / 1_000_000 },
    ]);
  });

  it("has no rate for a vendor that reported no price", () => {
    expect(observedRates(buildLedger([]))).toEqual([]);
    expect(observedRates(undefined)).toEqual([]);
  });
});
