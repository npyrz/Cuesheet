import { describe, expect, it } from "vitest";
import {
  duration,
  elapsed,
  isMac,
  isPaletteChord,
  modifierKey,
  money,
  shortPath,
  statusDot,
  tokens,
} from "./format.js";

describe("duration", () => {
  it("renders the README's 4m12s shape", () => {
    expect(duration(252_000)).toBe("4m12s");
  });

  it("pads seconds and minutes so the tile does not jitter", () => {
    expect(duration(61_000)).toBe("1m01s");
    expect(duration(3_660_000)).toBe("1h01m");
  });

  it("drops to bare seconds under a minute", () => {
    expect(duration(9_000)).toBe("9s");
    expect(duration(0)).toBe("0s");
  });
});

describe("elapsed", () => {
  it("measures between two stamps", () => {
    expect(
      elapsed("2026-09-10T14:00:00.000Z", "2026-09-10T14:04:12.000Z"),
    ).toBe("4m12s");
  });

  it("never goes negative on a clock that stepped backwards", () => {
    expect(
      elapsed("2026-09-10T14:04:12.000Z", "2026-09-10T14:00:00.000Z"),
    ).toBe("0s");
  });

  it("renders an em dash rather than NaN for a bad stamp", () => {
    expect(elapsed("not a date", "2026-09-10T14:00:00.000Z")).toBe("—");
  });
});

describe("money", () => {
  it("formats a real cost", () => {
    expect(money({ tokensIn: 1, tokensOut: 1, usd: 0.84 })).toBe("$0.84");
  });

  it('says "local" for a harness that burned tokens and cannot price them', () => {
    // An ollama Station costs nothing, and showing $0.00 would make an
    // unknown look like a measurement.
    expect(money({ tokensIn: 900, tokensOut: 120 })).toBe("local");
  });

  it('says "—" before anything has been reported, not "local"', () => {
    // The bug this guards: a claude-code run shows its tile for several
    // seconds before the first usage event lands. Calling that "local"
    // labels a cloud model as free for exactly as long as nobody can tell.
    expect(money(undefined)).toBe("—");
    expect(money({ tokensIn: 0, tokensOut: 0 })).toBe("—");
  });

  it("distinguishes a measured zero from an unpriced one", () => {
    expect(money({ tokensIn: 0, tokensOut: 0, usd: 0 })).toBe("$0.00");
  });

  it("does not round a real cost down to nothing", () => {
    expect(money({ tokensIn: 1, tokensOut: 1, usd: 0.0004 })).toBe("<$0.01");
  });
});

describe("tokens", () => {
  it("abbreviates at thousands and millions", () => {
    expect(tokens(999)).toBe("999");
    expect(tokens(12_345)).toBe("12.3k");
    expect(tokens(2_500_000)).toBe("2.5M");
  });
});

describe("shortPath", () => {
  it("keeps the tail, which is the part that identifies the file", () => {
    expect(shortPath("/Users/noah/code/api/src/limit.ts")).toBe(
      "…/src/limit.ts",
    );
  });

  it("leaves a short path alone", () => {
    expect(shortPath("src/limit.ts")).toBe("src/limit.ts");
  });

  it("handles Windows separators", () => {
    expect(shortPath("C:\\Users\\noah\\code\\api\\src\\limit.ts")).toBe(
      "…/src/limit.ts",
    );
  });
});

describe("statusDot", () => {
  it("marks terminal and live states differently", () => {
    expect(statusDot("running")).toBe("●");
    expect(statusDot("done")).toBe("✓");
    expect(statusDot("failed")).toBe("✕");
    expect(statusDot("standby")).toBe("✋");
    expect(statusDot("queued")).toBe("○");
  });
});

describe("the modifier key", () => {
  it("is ⌘ on a Mac and Ctrl everywhere else", () => {
    // The cross-platform checklist item, settled here rather than in Step 24.
    expect(modifierKey("darwin")).toBe("⌘");
    expect(modifierKey("MacIntel")).toBe("⌘");
    expect(modifierKey("win32")).toBe("Ctrl");
    expect(modifierKey("Win32")).toBe("Ctrl");
    expect(modifierKey("Linux x86_64")).toBe("Ctrl");
  });

  it("treats an undetectable platform as not-Mac, so the hint reads Ctrl", () => {
    // Checked through `isMac` rather than `modifierKey(undefined)`: passing
    // `undefined` triggers the default parameter, which runs real detection
    // — and this test process *has* a `navigator`, so it would assert the
    // host's platform rather than the fallback.
    expect(isMac(undefined)).toBe(false);
    expect(isMac("")).toBe(false);
  });
});

describe("the palette chord", () => {
  const cmdK = { key: "k", metaKey: true, ctrlKey: false };
  const ctrlK = { key: "k", metaKey: false, ctrlKey: true };

  it("is ⌘K on a Mac and Ctrl+K on Windows", () => {
    expect(isPaletteChord(cmdK, "darwin")).toBe(true);
    expect(isPaletteChord(ctrlK, "darwin")).toBe(false);
    expect(isPaletteChord(ctrlK, "win32")).toBe(true);
    expect(isPaletteChord(cmdK, "win32")).toBe(false);
  });

  it("accepts a capital K, which is what shift produces", () => {
    expect(isPaletteChord({ ...cmdK, key: "K" }, "darwin")).toBe(true);
  });

  it("ignores every other key", () => {
    expect(isPaletteChord({ ...cmdK, key: "j" }, "darwin")).toBe(false);
  });
});
