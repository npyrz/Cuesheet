import { describe, expect, it } from "vitest";
import type { ListedProject } from "@cuesheet/core";
import { activeProject, describeSwitcher, switchCommands } from "./switcher.js";

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

describe("describeSwitcher", () => {
  it("marks exactly one row active", () => {
    const rows = describeSwitcher(
      [project({ id: "a" }), project({ id: "b" }), project({ id: "c" })],
      "b",
      now,
    );
    expect(rows.filter((row) => row.active).map((row) => row.id)).toEqual([
      "b",
    ]);
  });

  it("marks none active when no project is open", () => {
    const rows = describeSwitcher([project({ id: "a" })], null, now);
    expect(rows.some((row) => row.active)).toBe(false);
  });

  it("still refuses to make a missing folder a click target", () => {
    // The same rule the launch surface obeys, asked of the switcher — because
    // these are two renders of one list and the rule has one implementation.
    const [row] = describeSwitcher(
      [project({ id: "a", status: "missing" })],
      "b",
      now,
    );
    expect(row?.openable).toBe(false);
    expect(row?.problem).toContain("not where Cuesheet last saw it");
  });

  it("does not float the active project to the top", () => {
    // A menu you move away from. Re-ordering by where you already are puts the
    // entry you want somewhere new after every switch.
    const rows = describeSwitcher(
      [project({ id: "a" }), project({ id: "b" }), project({ id: "c" })],
      "c",
      now,
    );
    expect(rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
});

describe("switchCommands", () => {
  const rows = (activeId: string | null) =>
    describeSwitcher(
      [
        project({ id: "a", name: "api" }),
        project({ id: "b", name: "web" }),
        project({ id: "c", name: "gone", status: "missing" }),
      ],
      activeId,
      now,
    );

  it("offers every other project that can be opened", () => {
    expect(switchCommands(rows("a")).map((c) => c.projectId)).toEqual(["b"]);
  });

  it("does not offer the project you are already on", () => {
    expect(switchCommands(rows("b")).some((c) => c.projectId === "b")).toBe(
      false,
    );
  });

  it("leaves out a project whose folder is gone", () => {
    // Not a greyed-out command: a palette lists things you can do, and the
    // reason a missing folder is worth showing at all — so nobody concludes it
    // was deleted — is served by the menu, which can show a row and its reason
    // at once.
    expect(switchCommands(rows("a")).some((c) => c.projectId === "c")).toBe(
      false,
    );
  });

  it("names the folder, because two checkouts share a name", () => {
    const commands = switchCommands(
      describeSwitcher(
        [
          project({ id: "a", name: "api", root: "/Users/noah/code/api" }),
          project({ id: "b", name: "api", root: "/Users/noah/work/api" }),
        ],
        "a",
        now,
      ),
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]?.label).toContain("api");
    expect(commands[0]?.label).toContain("work");
  });

  // A property of the function, not a path through the app: with no project
  // open the Desk renders the launch surface and there is no palette to carry
  // these. Asserted anyway because `activeId` is nullable and a caller that
  // starts passing `null` — a switcher on the launch surface, say — should get
  // every project rather than none.
  it("offers all of them when nothing is open", () => {
    expect(switchCommands(rows(null)).map((c) => c.projectId)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("activeProject", () => {
  it("carries the root, so two projects with one name are distinguishable", () => {
    expect(activeProject(project({ id: "a" }))).toEqual({
      id: "a",
      name: "api",
      root: "/Users/noah/code/api",
    });
  });

  it("says null when nothing is open", () => {
    // What the window title and the tray are told when the Desk is on the
    // launch surface. They must follow it back, or they advertise a project
    // the window is not showing.
    expect(activeProject(null)).toBeNull();
  });
});
