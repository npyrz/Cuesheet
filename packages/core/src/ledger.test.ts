import { describe, expect, it } from "vitest";
import { buildLedger, cacheHitRate, utcDay } from "./ledger.js";
import type { Cost, Run, StationCost } from "./types.js";

function run(overrides: Partial<Run> & { id: string }): Run {
  return {
    kind: "prompt",
    status: "done",
    prompt: "do the thing",
    stationIds: ["opus"],
    workspace: "/ws",
    createdAt: "2026-09-16T10:00:00Z",
    cost: { tokensIn: 0, tokensOut: 0 },
    ...overrides,
  };
}

function station(stationId: string, vendor: string, cost: Cost): StationCost {
  return { stationId, harness: `${vendor}-cli`, vendor, cost };
}

describe("buildLedger", () => {
  /**
   * Step 42 found this by putting `totals` and `byStation` on one screen: the
   * card read "1 run" and the header read "0 runs" about the same run. Every
   * bucket counted through `bump`; the grand total went through `add`, which
   * takes a `Cost` and has no notion of a run.
   */
  it("counts the runs in its own total, not only in every bucket", () => {
    const ledger = buildLedger([
      run({
        id: "r1",
        cost: { tokensIn: 10, tokensOut: 2, usd: 0.3 },
        result: {
          status: "done",
          durationMs: 1,
          cost: { tokensIn: 10, tokensOut: 2, usd: 0.3 },
          stations: [
            station("opus", "anthropic", {
              tokensIn: 10,
              tokensOut: 2,
              usd: 0.3,
            }),
          ],
        },
      }),
      run({ id: "r2", cost: { tokensIn: 4, tokensOut: 1 } }),
    ]);
    expect(ledger.totals.runs).toBe(2);
    // And the columns still describe the same two runs.
    expect(ledger.byDay.reduce((sum, row) => sum + row.runs, 0)).toBe(2);
    expect(ledger.runs).toHaveLength(2);
  });

  it("counts a run with no split as one unattributed run", () => {
    const ledger = buildLedger([
      run({ id: "r1", cost: { tokensIn: 4, tokensOut: 1, usd: 0.1 } }),
    ]);
    expect(ledger.unattributed.runs).toBe(1);
  });

  it("does not count a remainder as another unattributed run", () => {
    // The run is already counted in `byStation`; counting its leftover here
    // too would make the two columns describe different populations.
    const ledger = buildLedger([
      run({
        id: "r1",
        cost: { tokensIn: 100, tokensOut: 10, usd: 1 },
        result: {
          status: "done",
          durationMs: 1,
          cost: { tokensIn: 100, tokensOut: 10, usd: 1 },
          stations: [
            station("opus", "anthropic", {
              tokensIn: 60,
              tokensOut: 6,
              usd: 0.6,
            }),
          ],
        },
      }),
    ]);
    expect(ledger.unattributed.runs).toBe(0);
    expect(ledger.unattributed.usd).toBeCloseTo(0.4);
    expect(ledger.totals.runs).toBe(1);
  });

  it("splits a two-vendor run across its Stations", () => {
    // The Phase 7 shape: one engineer writes, a reviewer from a second vendor
    // checks. What the ledger is for is telling you which of the two the money
    // went to.
    const ledger = buildLedger([
      run({
        id: "r1",
        cost: { tokensIn: 1000, tokensOut: 100, usd: 0.56 },
        result: {
          status: "held",
          cost: { tokensIn: 1000, tokensOut: 100, usd: 0.56 },
          durationMs: 1,
          stations: [
            station("opus", "anthropic", {
              tokensIn: 800,
              tokensOut: 80,
              usd: 0.45,
            }),
            station("codex", "openai", {
              tokensIn: 200,
              tokensOut: 20,
              usd: 0.11,
            }),
          ],
        },
      }),
    ]);

    expect(ledger.totals).toMatchObject({ tokensIn: 1000, tokensOut: 100 });
    expect(ledger.byVendor.map((r) => r.key)).toEqual(["anthropic", "openai"]);
    expect(ledger.byStation[0]).toMatchObject({ key: "opus", tokensIn: 800 });
    expect(ledger.byStation[1]).toMatchObject({ key: "codex", tokensIn: 200 });
    // It adds up, so nothing lands in the unattributed column.
    expect(ledger.unattributed).toMatchObject({ tokensIn: 0, tokensOut: 0 });
  });

  it("keeps a run recorded before per-Station costs, and says it is unsplit", () => {
    // The clause this exists for. The Phase 7 gate run was recorded long
    // before `stations` was a field, so the honest answer is a row in the day
    // and run totals with its spend called out as unattributable — not a
    // dropped run, and not one silently blamed on its first Station.
    const ledger = buildLedger([
      run({ id: "old", cost: { tokensIn: 500, tokensOut: 50, usd: 0.56 } }),
    ]);

    expect(ledger.totals.tokensIn).toBe(500);
    expect(ledger.runs[0]).toMatchObject({ runId: "old", attributed: false });
    expect(ledger.byStation).toEqual([]);
    expect(ledger.unattributed).toMatchObject({
      tokensIn: 500,
      tokensOut: 50,
      usd: 0.56,
    });
  });

  it("never adds the cache breakdown to the input it is part of", () => {
    // The single arithmetic error that would inflate every figure on the page
    // by roughly a cache hit rate — which on a warm repository is most of it.
    const ledger = buildLedger([
      run({
        id: "r1",
        cost: {
          tokensIn: 50_270,
          tokensOut: 317,
          cacheRead: 24_950,
          cacheWrite: 25_303,
        },
      }),
    ]);
    expect(ledger.totals.tokensIn).toBe(50_270);
    expect(ledger.totals.cacheRead).toBe(24_950);
    expect(ledger.totals.cacheWrite).toBe(25_303);
  });

  it("leaves the breakdown absent when nobody reported one", () => {
    // Absent is not zero. A local model that says nothing about caching has
    // not told you its hit rate was zero.
    const ledger = buildLedger([
      run({ id: "r1", cost: { tokensIn: 100, tokensOut: 10 } }),
    ]);
    expect(ledger.totals.cacheRead).toBeUndefined();
    expect(cacheHitRate(ledger.totals)).toBeNull();
  });

  it("keeps a partial breakdown partial", () => {
    // One harness reports cache figures and another does not, which is exactly
    // the shipped two-vendor case: `codex` reports a read and no write.
    const ledger = buildLedger([
      run({
        id: "r1",
        cost: { tokensIn: 300, tokensOut: 30 },
        result: {
          status: "done",
          cost: { tokensIn: 300, tokensOut: 30 },
          durationMs: 1,
          stations: [
            station("opus", "anthropic", {
              tokensIn: 200,
              tokensOut: 20,
              cacheRead: 150,
              cacheWrite: 10,
            }),
            station("qwen", "ollama", { tokensIn: 100, tokensOut: 10 }),
          ],
        },
      }),
    ]);
    const anthropic = ledger.byVendor.find((r) => r.key === "anthropic");
    const ollama = ledger.byVendor.find((r) => r.key === "ollama");
    expect(anthropic?.cacheRead).toBe(150);
    expect(ollama?.cacheRead).toBeUndefined();
    expect(cacheHitRate(ollama!)).toBeNull();
  });

  it("puts the remainder in `unattributed` when the split falls short", () => {
    // Happens whenever the queue preferred a harness's settled total over the
    // metered stream. Visible rather than hidden: a `byStation` column that
    // does not reconcile with the total is a reason to distrust the page.
    const ledger = buildLedger([
      run({
        id: "r1",
        cost: { tokensIn: 1000, tokensOut: 100 },
        result: {
          status: "done",
          cost: { tokensIn: 1000, tokensOut: 100 },
          durationMs: 1,
          stations: [
            station("opus", "anthropic", { tokensIn: 700, tokensOut: 70 }),
          ],
        },
      }),
    ]);
    expect(ledger.unattributed).toMatchObject({
      tokensIn: 300,
      tokensOut: 30,
    });
  });

  it("groups by UTC day, newest first", () => {
    const ledger = buildLedger([
      run({ id: "a", createdAt: "2026-09-16T10:00:00Z", cost: c(10) }),
      run({ id: "b", createdAt: "2026-09-15T23:59:59Z", cost: c(20) }),
      run({ id: "c", createdAt: "2026-09-16T23:00:00Z", cost: c(30) }),
    ]);
    expect(ledger.byDay.map((r) => r.key)).toEqual([
      "2026-09-16",
      "2026-09-15",
    ]);
    expect(ledger.byDay[0]).toMatchObject({ tokensIn: 40, runs: 2 });
  });

  it("honours a date window", () => {
    const runs = [
      run({ id: "a", createdAt: "2026-09-14T10:00:00Z", cost: c(10) }),
      run({ id: "b", createdAt: "2026-09-16T10:00:00Z", cost: c(20) }),
    ];
    expect(buildLedger(runs, { since: "2026-09-15" }).totals.tokensIn).toBe(20);
    expect(buildLedger(runs, { until: "2026-09-15" }).totals.tokensIn).toBe(10);
  });

  it("counts a failed run's spend, because it was still spent", () => {
    const ledger = buildLedger([
      run({ id: "r1", status: "failed", cost: c(120) }),
    ]);
    expect(ledger.totals.tokensIn).toBe(120);
  });

  it("is empty rather than broken with no runs", () => {
    const ledger = buildLedger([]);
    expect(ledger.totals).toEqual({ tokensIn: 0, tokensOut: 0, runs: 0 });
    expect(ledger.byDay).toEqual([]);
  });
});

describe("cacheHitRate", () => {
  it("is the fraction of input served from cache", () => {
    expect(
      cacheHitRate({ tokensIn: 1000, tokensOut: 0, cacheRead: 750, runs: 1 }),
    ).toBe(0.75);
  });

  it("is null rather than zero when there was no input", () => {
    expect(
      cacheHitRate({ tokensIn: 0, tokensOut: 0, cacheRead: 0, runs: 1 }),
    ).toBeNull();
  });
});

describe("utcDay", () => {
  it("does not shift under a traveller", () => {
    expect(utcDay("2026-09-16T23:59:59Z")).toBe("2026-09-16");
    expect(utcDay("2026-09-17T00:00:01Z")).toBe("2026-09-17");
  });

  it("names an unparseable stamp rather than throwing", () => {
    expect(utcDay("not a date")).toBe("unknown");
  });
});

function c(tokensIn: number): Cost {
  return { tokensIn, tokensOut: Math.round(tokensIn / 10) };
}
