import { describe, expect, it } from "vitest";
import type { RunResultSummary } from "@cuesheet/core/types";
import { summarise } from "./summary.js";

function result(overrides: Partial<RunResultSummary> = {}): RunResultSummary {
  return {
    status: "done",
    cost: { tokensIn: 100, tokensOut: 50, usd: 0.84 },
    durationMs: 11_000,
    ...overrides,
  };
}

describe("summarise", () => {
  it("reads as a sentence about a finished run", () => {
    expect(
      summarise(
        result({ diff: { filesChanged: 3, insertions: 9, deletions: 1 } }),
      ),
    ).toBe("done in 11s · 3 files changed · $0.84");
  });

  it("says nothing about files when the run touched none", () => {
    expect(summarise(result())).toBe("done in 11s · $0.84");
  });

  it("counts one file singularly", () => {
    expect(
      summarise(
        result({ diff: { filesChanged: 1, insertions: 2, deletions: 0 } }),
      ),
    ).toBe("done in 11s · 1 file changed · $0.84");
  });

  it("omits the price a local model does not have", () => {
    // `usd` absent is not `$0.00`: a local run costs something, just not money.
    expect(summarise(result({ cost: { tokensIn: 10, tokensOut: 4 } }))).toBe(
      "done in 11s",
    );
  });

  it("never rounds a fast run down to zero seconds", () => {
    expect(summarise(result({ durationMs: 400 }))).toBe("done in 1s · $0.84");
  });

  it("carries a failure's own status word", () => {
    expect(summarise(result({ status: "failed" }))).toContain("failed in 11s");
  });

  it("survives a done event with no result at all", () => {
    expect(summarise(undefined)).toBe("The run is finished.");
  });
});
