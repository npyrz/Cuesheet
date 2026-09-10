import { describe, expect, it } from "vitest";
import {
  compactStamp,
  createRunIdFactory,
  isRunId,
  RUN_ID_PATTERN,
} from "./ids.js";

const at = (iso: string) => new Date(iso);

describe("compactStamp", () => {
  it("strips every character illegal in a Windows path", () => {
    const stamp = compactStamp(at("2026-09-10T14:22:33.104Z"));
    expect(stamp).toBe("20260910T142233104Z");
    // A colon is legal on POSIX and illegal on Windows, so an id built from a
    // raw `toISOString()` creates a directory on macOS and throws on Windows.
    expect(stamp).not.toContain(":");
    expect(stamp).not.toContain(".");
  });

  it("is fixed-width, so lexical order is chronological order", () => {
    const a = compactStamp(at("2026-09-10T09:00:00.000Z"));
    const b = compactStamp(at("2026-09-10T10:00:00.000Z"));
    expect(a.length).toBe(b.length);
    expect(a < b).toBe(true);
  });
});

describe("run id factory", () => {
  it("zero-pads the counter so same-millisecond runs still sort", () => {
    const newId = createRunIdFactory(8);
    const when = at("2026-09-10T14:22:33.104Z");
    const ninth = newId(when);
    const tenth = newId(when);

    expect(ninth).toBe("20260910T142233104Z-0008");
    expect(tenth).toBe("20260910T142233104Z-0009");

    // The reason for the padding: unpadded, `-10` sorts before `-9`.
    const eleventh = newId(when);
    expect([eleventh, ninth, tenth].sort()).toEqual([ninth, tenth, eleventh]);
  });

  it("orders ids across milliseconds regardless of counter", () => {
    const newId = createRunIdFactory(9999);
    const earlier = newId(at("2026-09-10T14:22:33.104Z"));
    const later = newId(at("2026-09-10T14:22:33.105Z"));
    expect(earlier < later).toBe(true);
  });

  it("produces ids that validate", () => {
    const newId = createRunIdFactory();
    expect(isRunId(newId(at("2026-09-10T14:22:33.104Z")))).toBe(true);
  });
});

describe("isRunId", () => {
  it("rejects path traversal, because a run id becomes a directory name", () => {
    for (const hostile of [
      "../../etc/passwd",
      "..",
      "20260910T142233104Z-0000/../../secrets",
      "/absolute",
      "C:\\Windows",
      "20260910T142233104Z-0000\u0000",
    ]) {
      expect(isRunId(hostile), hostile).toBe(false);
    }
  });

  it("rejects near-misses and non-strings", () => {
    expect(isRunId("20260910T142233104Z")).toBe(false); // no counter
    expect(isRunId("20260910T142233104Z-1")).toBe(false); // unpadded
    expect(isRunId("")).toBe(false);
    expect(isRunId(undefined)).toBe(false);
    expect(isRunId(42)).toBe(false);
  });

  it("is anchored at both ends", () => {
    expect(RUN_ID_PATTERN.source.startsWith("^")).toBe(true);
    expect(RUN_ID_PATTERN.source.endsWith("$")).toBe(true);
  });
});
