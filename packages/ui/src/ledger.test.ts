import { describe, expect, it } from "vitest";
import type { Ledger, LedgerTotals } from "@cuesheet/core";
import { compact, toCell, unattributedNote } from "./ledger.js";

const totals = (over: Partial<LedgerTotals> = {}): LedgerTotals => ({
  tokensIn: 0,
  tokensOut: 0,
  runs: 0,
  ...over,
});

describe("toCell", () => {
  it("shows a cache share when one was reported", () => {
    const cell = toCell(
      "anthropic",
      totals({ tokensIn: 1000, cacheRead: 750 }),
    );
    expect(cell.cache).toBe("75%");
  });

  it("shows a dash rather than 0% when nobody reported a breakdown", () => {
    // `codex` reports a read and no write; a local model reports neither; a
    // run from before Step 39 reports nothing. A column of confident zeroes
    // across those would change what somebody optimises.
    expect(toCell("ollama", totals({ tokensIn: 500 })).cache).toBe("—");
  });

  it("shows a dash rather than $0.00 when nothing carried a price", () => {
    // `codex` never reports a dollar figure. "$0.00" would say the run was
    // free, which is a different claim from "nobody priced it".
    expect(toCell("openai", totals({ tokensIn: 500 })).usd).toBe("—");
    expect(toCell("anthropic", totals({ usd: 0.56 })).usd).toBe("$0.56");
  });
});

describe("unattributedNote", () => {
  const ledger = (over: Partial<Ledger>): Ledger => ({
    totals: totals(),
    byDay: [],
    byVendor: [],
    byStation: [],
    runs: [],
    unattributed: totals(),
    ...over,
  });

  it("says nothing when everything reconciles", () => {
    expect(unattributedNote(ledger({}))).toBeNull();
  });

  it("names the older runs when they are why", () => {
    const note = unattributedNote(
      ledger({
        unattributed: totals({ tokensIn: 5_000, tokensOut: 500 }),
        runs: [
          {
            runId: "old",
            day: "2026-01-01",
            status: "held",
            prompt: "p",
            attributed: false,
            tokensIn: 5_000,
            tokensOut: 500,
            runs: 1,
          },
        ],
      }),
    );
    expect(note).toContain("predate per-Station accounting");
    expect(note).toContain("5.0k");
  });

  it("gives the other reason when every run is attributed", () => {
    const note = unattributedNote(
      ledger({ unattributed: totals({ tokensIn: 300, tokensOut: 30 }) }),
    );
    expect(note).toContain("settled total that differs");
  });
});

describe("compact", () => {
  it("keeps tables readable past four digits", () => {
    expect(compact(999)).toBe("999");
    expect(compact(50_270)).toBe("50.3k");
    expect(compact(1_400_000)).toBe("1.4M");
  });
});
