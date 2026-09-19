import { describe, expect, it } from "vitest";
import { checkLimits, measuredFraction, percent } from "./limits.js";
import { parseConfig } from "./config.js";
import type { HarnessUsage, UsageWindow } from "./types.js";

const limits = parseConfig("", null).config.limits;

function usage(
  harness: string,
  vendor: string,
  windows: UsageWindow[],
): HarnessUsage {
  return { harness, vendor, windows };
}

describe("checkLimits", () => {
  it("starts a run when nothing measured anything", () => {
    // The everyday case with the harnesses that ship today: a status, a
    // silence and a local model. None of the three is a measurement, so none
    // of them may stop anybody working.
    const check = checkLimits({
      limits,
      usage: [
        usage("claude-code", "anthropic", [
          { window: "five_hour", state: "not-blocked" },
        ]),
        usage("codex", "openai", [{ window: "plan", state: "unknown" }]),
        usage("mock", "cuesheet", [{ window: "local", state: "unmetered" }]),
      ],
    });
    expect(check).toEqual({ decision: "go", findings: [] });
  });

  it("warns at warn_at without stopping the run", () => {
    const check = checkLimits({
      limits,
      usage: [
        usage("x", "anthropic", [
          { window: "weekly", state: "measured", used: 0.9 },
        ]),
      ],
    });
    expect(check.decision).toBe("warn");
    expect(check.findings[0]?.reason).toContain("90%");
  });

  it("blocks at block_at, and says which window and why", () => {
    const check = checkLimits({
      limits,
      usage: [
        usage("x", "anthropic", [
          { window: "five_hour", state: "measured", used: 1 },
        ]),
      ],
    });
    expect(check.decision).toBe("block");
    expect(check.findings[0]).toMatchObject({
      vendor: "anthropic",
      window: "five_hour",
      used: 1,
    });
    expect(check.findings[0]?.reason).toContain("would not finish");
  });

  it("ignores harnesses the run will not touch", () => {
    // A run that only uses `claude-code` must not be refused because a Codex
    // Station elsewhere in the config is capped — it would never reach it.
    const check = checkLimits({
      limits,
      harnesses: ["claude-code"],
      usage: [
        usage("claude-code", "anthropic", [
          { window: "5h", state: "not-blocked" },
        ]),
        usage("codex", "openai", [
          { window: "plan", state: "measured", used: 1 },
        ]),
      ],
    });
    expect(check.decision).toBe("go");
  });

  it("lets the worst window decide, and sorts it first", () => {
    const check = checkLimits({
      limits,
      usage: [
        usage("x", "anthropic", [
          { window: "weekly", state: "measured", used: 0.88 },
          { window: "five_hour", state: "measured", used: 0.99 },
        ]),
      ],
    });
    expect(check.decision).toBe("block");
    expect(check.findings.map((f) => f.window)).toEqual([
      "five_hour",
      "weekly",
    ]);
  });

  it("honours thresholds an operator moved", () => {
    const tight = parseConfig("[limits]\nwarn_at = 0.5\nblock_at = 0.6\n", null)
      .config.limits;
    const half: HarnessUsage[] = [
      usage("x", "anthropic", [
        { window: "weekly", state: "measured", used: 0.55 },
      ]),
    ];
    expect(checkLimits({ limits: tight, usage: half }).decision).toBe("warn");
    expect(checkLimits({ limits, usage: half }).decision).toBe("go");
  });
});

describe("measuredFraction", () => {
  it("is null for every variant that measured nothing", () => {
    // The union's guarantee, cashed in. There is no `used` to fall back to on
    // these three, which is why no `?? 0` can be written here by accident.
    expect(measuredFraction({ window: "w", state: "not-blocked" })).toBeNull();
    expect(measuredFraction({ window: "w", state: "unmetered" })).toBeNull();
    expect(measuredFraction({ window: "w", state: "unknown" })).toBeNull();
    expect(
      measuredFraction({ window: "w", state: "measured", used: 0.4 }),
    ).toBe(0.4);
  });
});

describe("percent", () => {
  it("rounds for prose", () => {
    expect(percent(0.714)).toBe("71%");
    expect(percent(1)).toBe("100%");
  });
});

describe("[limits] as config", () => {
  it("defaults to the README's numbers when the table is absent", () => {
    expect(limits).toMatchObject({ warn_at: 0.85, block_at: 0.97 });
  });

  it("no longer warns that the table is unimplemented", () => {
    // It was in `DEFERRED_TABLES` until Step 38. The warning was true then and
    // would be a lie now.
    const loaded = parseConfig("[limits]\nwarn_at = 0.5\n", null);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.config.limits.warn_at).toBe(0.5);
    expect(loaded.deferred["limits"]).toBeUndefined();
  });

  it("keeps `when_capped` even though nothing reads it yet", () => {
    // Step 39 routes on this. Accepting it now is what lets a config written
    // against the README survive a round trip through the Desk's own writer.
    const loaded = parseConfig(
      '[limits]\nwhen_capped = { codex = "qwen" }\n',
      null,
    );
    expect(loaded.config.limits.when_capped).toEqual({ codex: "qwen" });
  });

  it("warns rather than throws when the thresholds are transposed", () => {
    // A half-written config still has to open the app. Refusing to start over
    // a swapped pair of numbers is a worse outcome than saying so on screen.
    const loaded = parseConfig(
      "[limits]\nwarn_at = 0.99\nblock_at = 0.5\n",
      null,
    );
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]?.table).toBe("limits");
    expect(loaded.warnings[0]?.message).toContain("Swap them");
  });
});
