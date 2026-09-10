/**
 * Diffing a workspace.
 *
 * The README's review loop needs a diff, and git is already a stated
 * requirement, so this shells out rather than reimplementing anything. It is
 * separate from any one harness because every harness that edits files needs
 * the same answer, and it is separate from `spawn.ts` because *what* to ask
 * git is a different problem from how to start a process safely.
 */
import { run, which } from "./spawn.js";
import type { DiffResult } from "./types.js";
import type { DiffStat } from "@cuesheet/core";

export const EMPTY_DIFF: DiffResult = {
  patch: "",
  stat: { filesChanged: 0, insertions: 0, deletions: 0 },
};

export interface GitDiffOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Whether `cwd` is inside a git work tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  if ((await which("git")) === null) return false;
  try {
    const result = await run("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      timeoutMs: 10_000,
    });
    return result.code === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * The diff of everything the run changed, tracked and untracked.
 *
 * **`git diff` alone is wrong here.** It only reports tracked files, so a run
 * whose entire contribution is a new file produces an empty patch and looks
 * like it did nothing — which is both the most common agent output and the
 * most misleading way to fail. `git add -A -N` records new files as
 * intent-to-add so `git diff` sees them.
 *
 * That does touch the index: interrupted mid-run, the new files stay marked
 * intent-to-add. It is a marker, not staged content — `git reset` clears it
 * and nothing is committed — and it is a smaller cost than a diff that lies.
 *
 * Outside a repository this resolves to {@link EMPTY_DIFF}. A missing `.git`
 * is a reason to have no diff, not a reason to fail a run that already did its
 * work.
 */
export async function diffWorkspace(
  options: GitDiffOptions,
): Promise<DiffResult> {
  const { cwd } = options;
  if (!(await isGitRepo(cwd))) return EMPTY_DIFF;

  const timeoutMs = options.timeoutMs ?? 60_000;
  const common = {
    cwd,
    timeoutMs,
    ...(options.signal !== undefined && { signal: options.signal }),
  };

  // Best-effort: a repo mid-rebase or with an index.lock will refuse, and a
  // tracked-only diff is still far better than none.
  await run("git", ["add", "-A", "-N"], common).catch(() => undefined);

  const patch = await run("git", ["diff", "--no-color"], common);
  const numstat = await run("git", ["diff", "--numstat", "--no-color"], common);

  return {
    patch: patch.code === 0 ? patch.stdout : "",
    stat: numstat.code === 0 ? parseNumstat(numstat.stdout) : EMPTY_DIFF.stat,
  };
}

/**
 * Parse `git diff --numstat`.
 *
 * Chosen over `--shortstat` because `--shortstat`'s prose ("3 files changed,
 * 1 insertion(+)") is localised and singular/plural-inflected, so parsing it
 * is a regex that breaks on someone else's machine. `--numstat` is columns.
 *
 * Binary files report `-` for both counts. They changed — so they count
 * toward `filesChanged` — but they contribute no lines.
 */
export function parseNumstat(text: string): DiffStat {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    filesChanged += 1;
    const added = Number.parseInt(parts[0] ?? "", 10);
    const removed = Number.parseInt(parts[1] ?? "", 10);
    if (Number.isFinite(added)) insertions += added;
    if (Number.isFinite(removed)) deletions += removed;
  }

  return { filesChanged, insertions, deletions };
}
