/**
 * What the launch surface shows before a project is open.
 *
 * Pure, and in a `.ts` for the reason `limits.ts` and `ledger.ts` are: vitest
 * collects colocated `.test.ts` files only and does not collect `.tsx`, so a
 * rule written in a component is a rule no test here can reach.
 *
 * The rule worth guarding: **a project whose folder is gone must not look like
 * one that opens.** The registry already answers that — `GET /projects` marks
 * every entry `ok` or `missing` — and the failure this file exists to prevent
 * is the UI receiving that answer and rendering both rows identically.
 */
import type { ListedProject } from "@cuesheet/core";
import { shortPath } from "./format.js";

export interface RecentRow {
  id: string;
  name: string;
  /** The folder, shortened for a list. The full path goes in a `title`. */
  where: string;
  root: string;
  /** `today`, `3 days ago`, or `never opened`. */
  when: string;
  /** False when the folder is not there. Such a row is not a click target. */
  openable: boolean;
  /**
   * Why it cannot be opened, or `null` when it can.
   *
   * There is deliberately no "moved" wording here, matching the comment on
   * `ProjectStatus` in core: without tracking inodes across platforms, a
   * renamed folder and a deleted one are indistinguishable, and a surface that
   * claimed to tell them apart would be guessing at the user.
   */
  problem: string | null;
}

export function describeRecents(
  projects: readonly ListedProject[],
  now: () => number = Date.now,
): RecentRow[] {
  // Order is the registry's — newest-opened first — and is not re-sorted here.
  // A picker that put missing folders last would bury the entry the person is
  // most likely looking for, which is the one that stopped working.
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    where: shortPath(project.root),
    root: project.root,
    when: lastOpened(project.lastOpenedAt, now),
    openable: project.status === "ok",
    problem:
      project.status === "ok"
        ? null
        : "This folder is not where Cuesheet last saw it.",
  }));
}

/**
 * What the launch surface says when there is nothing to list.
 *
 * A first-ever launch and a launch with six projects are different renders,
 * and the done-when names both — so the zero state gets a sentence of its own
 * rather than an empty list with a button under it. `canPick` is false in a
 * browser, where `window.cuesheet.chooseDirectory` does not exist.
 */
export function emptyState(canPick: boolean): {
  title: string;
  detail: string;
} {
  return canPick
    ? {
        title: "No projects yet.",
        detail:
          "Open the folder you want Cuesheet to work in. It will be " +
          "remembered here, and you can add as many as you like.",
      }
    : {
        title: "No projects yet.",
        detail:
          "The folder picker is part of the desktop app. In a browser, start " +
          "the daemon in a directory that has a cuesheet.toml — or open a " +
          "folder from the desktop app and it will appear here.",
      };
}

/** `today`, `yesterday`, `3 days ago`, `never opened`. */
function lastOpened(iso: string | null, now: () => number): string {
  if (iso === null) return "never opened";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "never opened";

  const days = Math.floor((now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${String(days)} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12)
    return `${String(months)} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${String(years)} year${years === 1 ? "" : "s"} ago`;
}
