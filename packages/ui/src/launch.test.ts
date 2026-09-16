import { describe, expect, it } from "vitest";
import type { ListedProject } from "@cuesheet/core";
import { describeRecents, emptyState } from "./launch.js";

const NOW = Date.parse("2026-09-16T12:00:00Z");
const now = () => NOW;
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function project(over: Partial<ListedProject> & { id: string }): ListedProject {
  return {
    name: "api",
    root: "/Users/noah/code/api",
    addedAt: daysAgo(30),
    lastOpenedAt: daysAgo(1),
    status: "ok",
    ...over,
  };
}

describe("describeRecents", () => {
  it("marks a folder that is not there as not openable, with a reason", () => {
    // The clause this exists for. The registry already answers `ok` or
    // `missing`; the failure being prevented is a UI that receives that answer
    // and renders both rows identically.
    const [row] = describeRecents(
      [project({ id: "p1", status: "missing" })],
      now,
    );
    expect(row?.openable).toBe(false);
    expect(row?.problem).toContain("not where Cuesheet last saw it");
  });

  it("says nothing about a folder having moved", () => {
    // Matching core's own note on `ProjectStatus`: without inode tracking, a
    // renamed folder and a deleted one are indistinguishable, and claiming to
    // tell them apart would be guessing at the user.
    const [row] = describeRecents(
      [project({ id: "p1", status: "missing" })],
      now,
    );
    expect(row?.problem).not.toMatch(/moved|renamed|deleted/i);
  });

  it("leaves a present folder openable and unexplained", () => {
    const [row] = describeRecents([project({ id: "p1" })], now);
    expect(row).toMatchObject({ openable: true, problem: null });
  });

  it("keeps the registry's order rather than burying the broken one", () => {
    // Newest-opened first is what the registry returns. Sorting missing
    // folders last would bury the entry somebody is most likely hunting for —
    // the one that stopped working.
    const rows = describeRecents(
      [
        project({ id: "a", lastOpenedAt: daysAgo(0), status: "missing" }),
        project({ id: "b", lastOpenedAt: daysAgo(4) }),
      ],
      now,
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("dates a recent in words, including one never opened", () => {
    const rows = describeRecents(
      [
        project({ id: "a", lastOpenedAt: daysAgo(0) }),
        project({ id: "b", lastOpenedAt: daysAgo(1) }),
        project({ id: "c", lastOpenedAt: daysAgo(3) }),
        project({ id: "d", lastOpenedAt: daysAgo(60) }),
        project({ id: "e", lastOpenedAt: daysAgo(400) }),
        project({ id: "f", lastOpenedAt: null }),
      ],
      now,
    );
    expect(rows.map((r) => r.when)).toEqual([
      "today",
      "yesterday",
      "3 days ago",
      "2 months ago",
      "1 year ago",
      "never opened",
    ]);
  });

  it("shortens the path for the list and keeps the full one", () => {
    const [row] = describeRecents([project({ id: "p1" })], now);
    // `shortPath` elides the head with `…/`, which is what makes a column of
    // home directories readable. The full path is kept for the `title`.
    expect(row?.where).toBe("…/code/api");
    expect(row?.root).toBe("/Users/noah/code/api");
  });
});

describe("emptyState", () => {
  it("tells a browser that the picker lives in the desktop app", () => {
    // `chooseDirectory` is Electron-only. A zero state whose one affordance is
    // a button that does not exist is broken in exactly the mode somebody
    // developing the UI runs it in.
    expect(emptyState(false).detail).toContain("desktop app");
    expect(emptyState(false).detail).toContain("cuesheet.toml");
  });

  it("says something deliberate rather than just showing a button", () => {
    const state = emptyState(true);
    expect(state.title).toBe("No projects yet.");
    expect(state.detail.length).toBeGreaterThan(40);
  });
});
