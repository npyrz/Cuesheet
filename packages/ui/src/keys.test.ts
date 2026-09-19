import { describe, expect, it } from "vitest";
import { isActivate, isDismiss, rove, trapIndex } from "./keys.js";

describe("rove", () => {
  it("steps down and up a list", () => {
    expect(rove("ArrowDown", { count: 5, current: 1 })).toBe(2);
    expect(rove("ArrowUp", { count: 5, current: 1 })).toBe(0);
  });

  it("wraps at both ends", () => {
    // Short, closed lists. Clamping reads as the key having stopped working.
    expect(rove("ArrowDown", { count: 3, current: 2 })).toBe(0);
    expect(rove("ArrowUp", { count: 3, current: 0 })).toBe(2);
  });

  it("enters the list at the near end when nothing is selected", () => {
    // `current + 1` from -1 is 0 by luck going down and -1 going up, so the
    // second of these is the one that was wrong before it was written out.
    expect(rove("ArrowDown", { count: 3, current: -1 })).toBe(0);
    expect(rove("ArrowUp", { count: 3, current: -1 })).toBe(2);
  });

  it("jumps to the ends", () => {
    expect(rove("Home", { count: 50, current: 27 })).toBe(0);
    expect(rove("End", { count: 50, current: 27 })).toBe(49);
  });

  it("returns null for anything else, so the caller does not swallow it", () => {
    // The palette's list sits under a text box. A component that
    // preventDefaults every keystroke stops people typing in it.
    expect(rove("a", { count: 3, current: 0 })).toBeNull();
    expect(rove("Enter", { count: 3, current: 0 })).toBeNull();
    expect(rove("ArrowLeft", { count: 3, current: 0 })).toBeNull();
  });

  it("returns null for an empty list rather than an index into nothing", () => {
    expect(rove("ArrowDown", { count: 0, current: -1 })).toBeNull();
    expect(rove("Home", { count: 0, current: -1 })).toBeNull();
  });
});

describe("trapIndex", () => {
  it("cycles forwards and backwards within the modal", () => {
    expect(trapIndex("Tab", false, { count: 4, current: 3 })).toBe(0);
    expect(trapIndex("Tab", true, { count: 4, current: 0 })).toBe(3);
  });

  it("enters at the top going forwards and the bottom going back", () => {
    // What a click on the scrim leaves behind: focus outside the trap.
    expect(trapIndex("Tab", false, { count: 4, current: -1 })).toBe(0);
    expect(trapIndex("Tab", true, { count: 4, current: -1 })).toBe(3);
  });

  it("ignores every key but Tab", () => {
    expect(trapIndex("ArrowDown", false, { count: 4, current: 0 })).toBeNull();
  });

  it("ignores a modal with nothing focusable in it", () => {
    expect(trapIndex("Tab", false, { count: 0, current: -1 })).toBeNull();
  });
});

describe("dismiss and activate", () => {
  it("knows both spellings of Escape", () => {
    // One spelling, in one place — `LedgerPanel` had its own, on an element
    // nothing ever focused.
    expect(isDismiss("Escape")).toBe(true);
    expect(isDismiss("Esc")).toBe(true);
    expect(isDismiss("Delete")).toBe(false);
  });

  it("activates on Enter and on Space, as a button does", () => {
    expect(isActivate("Enter")).toBe(true);
    expect(isActivate(" ")).toBe(true);
    expect(isActivate("Tab")).toBe(false);
  });
});
