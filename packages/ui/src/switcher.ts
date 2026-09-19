/**
 * What the switcher offers, and what the palette offers alongside it.
 *
 * Pure, and in a `.ts` for the reason `launch.ts` is: vitest collects
 * colocated `.test.ts` only and does not collect `.tsx`, so a rule written in
 * a component is a rule no test here can reach. Step 34's retrospective named
 * that split as the honest limit of its evidence and said this step is where
 * the switcher gets a surface worth exercising directly — which means the
 * decisions have to be somewhere a test can put a question to them.
 *
 * It is built on `describeRecents` rather than beside it. The launch surface
 * and the switcher are two renders of one list, and the rule that matters on
 * both — **a project whose folder is gone must not look like one that
 * opens** — is a rule that would rot the moment it had two implementations.
 */
import type { ListedProject } from "@cuesheet/core";
import type { ActiveProject } from "./api/base.js";
import { describeRecents, type RecentRow } from "./launch.js";

export interface SwitcherRow extends RecentRow {
  /** The project the Desk is on. Rendered, never a click target. */
  active: boolean;
}

export function describeSwitcher(
  projects: readonly ListedProject[],
  activeId: string | null,
  now: () => number = Date.now,
): SwitcherRow[] {
  // Registry order — newest-opened first — and deliberately not re-sorted to
  // float the active project to the top. The switcher is a list you move
  // *away* from; ordering it by where you already are would reshuffle the menu
  // on every switch and put the entry you want somewhere new each time.
  return describeRecents(projects, now).map((row) => ({
    ...row,
    active: row.id === activeId,
  }));
}

/** One palette entry for switching. `id` is the command's, not the project's. */
export interface SwitchCommand {
  id: string;
  projectId: string;
  label: string;
}

/**
 * The switch commands the palette should carry.
 *
 * The keyboard half of "switching is one action, reachable from anywhere":
 * `⌘K`, type a project name, Enter. That is the path that has to work with a
 * modal open, mid-run, and without a mouse — and it is why the switcher is
 * not only a menu in a corner of the topbar.
 *
 * A project that cannot be opened is left out. A palette lists *things you can
 * do*, and the reason a missing folder appears in the menu — so nobody
 * concludes their project was deleted — is served there, on a surface that can
 * show a row and its reason at the same time. A command that greys itself out
 * teaches you nothing the menu has not already told you.
 */
export function switchCommands(rows: readonly SwitcherRow[]): SwitchCommand[] {
  return rows
    .filter((row) => !row.active && row.openable)
    .map((row) => ({
      id: `switch-${row.id}`,
      projectId: row.id,
      // The path is in the label because two checkouts of the same repository
      // are the case a switcher exists for, and they have the same name.
      label: `Switch to ${row.name} — ${row.where}`,
    }));
}

/**
 * What the shell is told is open, or `null` when nothing is.
 *
 * The window title and the tray are the desktop's business and the Desk knows
 * nothing about either; `ActiveProject` in `api/base.ts` is the whole of what
 * crosses the bridge. `root` travels with it because two projects can share a
 * name, and a title bar that cannot tell them apart answers the wrong
 * question.
 */
export function activeProject(
  project: ListedProject | null,
): ActiveProject | null {
  if (project === null) return null;
  return { id: project.id, name: project.name, root: project.root };
}
