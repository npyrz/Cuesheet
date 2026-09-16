import { describe, expect, it } from "vitest";
import {
  parseConfig,
  type HarnessUsage,
  type UsageWindow,
} from "@cuesheet/core";
import { describeUsage, describeWindow } from "./limits.js";

const limits = parseConfig("", null).config.limits;

/** Fixed, so a reset clock and a staleness note are deterministic. */
const NOW = Date.parse("2026-09-16T12:00:00Z");
const now = () => NOW;

const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("describeWindow", () => {
  it("never produces a bar from an answer nobody measured", () => {
    // The assertion this whole file exists for. Three of the four variants
    // have no `used`, and the `?? 0` that would make a progress element happy
    // is the lie the phase is about.
    const silent: UsageWindow[] = [
      { window: "5h", state: "not-blocked" },
      { window: "local", state: "unmetered" },
      { window: "plan", state: "unknown" },
    ];
    for (const window of silent) {
      expect(describeWindow(window, limits, now).bar).toBeNull();
    }
  });

  it("says 'not blocked yet' rather than showing a comfortable zero", () => {
    const row = describeWindow(
      { window: "5h", state: "not-blocked" },
      limits,
      now,
    );
    expect(row.value).toBe("—");
    expect(row.note).toContain("Not blocked yet");
    expect(row.note).toContain("status, not a number");
  });

  it("draws the unmeterable row as infinite, not as empty", () => {
    // A local model cannot run out. Rendering it as 0% used is a lie in the
    // opposite direction from a vendor that reports nothing.
    const row = describeWindow(
      { window: "local", state: "unmetered" },
      limits,
      now,
    );
    expect(row.value).toBe("∞");
    expect(row.tone).toBe("free");
    expect(row.note).toContain("cannot run out");
  });

  it("carries a silence's reason through instead of inventing one", () => {
    const row = describeWindow(
      {
        window: "plan",
        state: "unknown",
        reason: "`codex` reports no plan windows.",
      },
      limits,
      now,
    );
    expect(row.tone).toBe("silent");
    expect(row.note).toBe("`codex` reports no plan windows.");
  });

  it("turns a measurement into a bar, and colours it by threshold", () => {
    const measured = (used: number): UsageWindow => ({
      window: "weekly",
      state: "measured",
      used,
    });
    expect(describeWindow(measured(0.34), limits, now)).toMatchObject({
      bar: 0.34,
      value: "34%",
      tone: "ok",
    });
    expect(describeWindow(measured(0.9), limits, now).tone).toBe("warn");
    expect(describeWindow(measured(0.99), limits, now)).toMatchObject({
      tone: "over",
      value: "99%",
    });
    expect(describeWindow(measured(0.99), limits, now).note).toContain(
      "runs are refused",
    );
  });

  it("shows the reset clock when the vendor gave one", () => {
    const row = describeWindow(
      {
        window: "five_hour",
        state: "not-blocked",
        resetsAt: at(108 * 60_000),
      },
      limits,
      now,
    );
    expect(row.note).toContain("Resets in 1h 48m.");
  });

  it("says how old a reading is, once it stops being new", () => {
    // `claude-code` can only report what a run overheard. A five-hour window
    // from this morning shown without its age is worse than a blank row,
    // because it looks current.
    const stale = describeWindow(
      { window: "5h", state: "not-blocked", seenAt: at(-40 * 60_000) },
      limits,
      now,
    );
    expect(stale.note).toContain("Last seen 40m ago.");

    const fresh = describeWindow(
      { window: "5h", state: "not-blocked", seenAt: at(-5_000) },
      limits,
      now,
    );
    expect(fresh.note).not.toContain("Last seen");
  });
});

describe("describeUsage", () => {
  const usage = (
    harness: string,
    vendor: string,
    windows: UsageWindow[],
  ): HarnessUsage => ({ harness, vendor, windows });

  it("groups by vendor, because a plan belongs to one", () => {
    // Two Stations on one CLI share a single window. Drawing it twice would
    // read as twice the budget.
    const rows = describeUsage(
      [
        usage("claude-code", "anthropic", [
          { window: "5h", state: "measured", used: 0.7 },
        ]),
        usage("claude-code-2", "anthropic", [
          { window: "weekly", state: "not-blocked" },
        ]),
      ],
      limits,
      now,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.harnesses).toEqual(["claude-code", "claude-code-2"]);
    expect(rows[0]?.windows.map((w) => w.window)).toEqual(["5h", "weekly"]);
  });

  it("puts whatever can stop you working nearest the top", () => {
    const rows = describeUsage(
      [
        usage("mock", "cuesheet", [{ window: "local", state: "unmetered" }]),
        usage("codex", "openai", [{ window: "plan", state: "unknown" }]),
        usage("claude-code", "anthropic", [
          { window: "5h", state: "measured", used: 0.99 },
        ]),
      ],
      limits,
      now,
    );
    expect(rows.map((r) => r.vendor)[0]).toBe("anthropic");
  });

  it("renders the shipped build's honest strip without a single bar", () => {
    // What an operator actually sees today: one vendor silent, one reporting a
    // status, one that cannot run out. No bars, and nothing pretending.
    const rows = describeUsage(
      [
        usage("claude-code", "anthropic", [
          { window: "five_hour", state: "not-blocked" },
        ]),
        usage("codex", "openai", [
          { window: "plan", state: "unknown", reason: "no plan windows" },
        ]),
        usage("mock", "cuesheet", [{ window: "local", state: "unmetered" }]),
      ],
      limits,
      now,
    );
    expect(rows).toHaveLength(3);
    expect(rows.flatMap((r) => r.windows).every((w) => w.bar === null)).toBe(
      true,
    );
  });
});
