/**
 * Diffing a workspace.
 *
 * The README's review loop needs a diff, and git is already a stated
 * requirement, so this shells out rather than reimplementing anything. It is
 * separate from any one harness because every harness that edits files needs
 * the same answer, and it is separate from `spawn.ts` because *what* to ask
 * git is a different problem from how to start a process safely.
 */
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

/**
 * A content-addressed snapshot of the working tree — Step 60.
 *
 * Why this exists at all: {@link diffWorkspace} answers "what is dirty", which
 * is everything uncommitted — this run's work, the run before it, and the
 * operator's own edits. That was always true and only became a defect when
 * something wanted to *undo* a run from its record: reverse-applying the
 * dirty diff undoes far more than the run did.
 *
 * Two snapshots, one before the first Station and one after the last, diff to
 * exactly the run's own change. Each is a tree object written through a
 * **temporary index**, so the operator's real index — staged work, intent-to-
 * add markers and all — is never touched, and no ref or commit is created in
 * their repository. The trees are unreferenced objects that `git gc` will
 * eventually prune, which is fine: the patch between them is computed at once
 * and kept in Cuesheet's own store.
 *
 * The real index is copied in first, so `git add -A` can use its stat cache
 * rather than re-hashing every file in the tree. `.gitignore` applies, so a
 * run's writes to ignored files are not captured and cannot be rewound.
 *
 * `null` outside a repository, or if git refuses — a snapshot is what makes a
 * rewind possible, never a reason to fail a run.
 */
export async function snapshotWorkspace(
  options: GitDiffOptions,
): Promise<string | null> {
  const { cwd } = options;
  if (!(await isGitRepo(cwd))) return null;
  const timeoutMs = options.timeoutMs ?? 60_000;

  const scratch = await mkdtemp(join(tmpdir(), "cuesheet-snapshot-"));
  try {
    const index = join(scratch, "index");
    const real = await run("git", ["rev-parse", "--git-path", "index"], {
      cwd,
      timeoutMs,
    });
    if (real.code === 0) {
      // A repository with nothing ever staged has no index yet; an empty
      // temporary one is then the right starting point.
      await copyFile(resolve(cwd, real.stdout.trim()), index).catch(
        () => undefined,
      );
    }
    const common = {
      cwd,
      timeoutMs,
      env: { ...process.env, GIT_INDEX_FILE: index },
      ...(options.signal !== undefined && { signal: options.signal }),
    };
    const added = await run("git", ["add", "-A"], common);
    if (added.code !== 0) return null;
    const tree = await run("git", ["write-tree"], common);
    const id = tree.stdout.trim();
    return tree.code === 0 && id !== "" ? id : null;
  } catch {
    return null;
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The patch from one snapshot to another: exactly what happened between.
 *
 * `--binary`, because reversing a binary change needs its full content, and
 * `--no-renames` so every section names one path — a rename is two paths in
 * one header, and a conflict report wants one path per file.
 */
export async function diffSnapshots(
  options: GitDiffOptions & { before: string; after: string },
): Promise<string | null> {
  if (options.before === options.after) return "";
  const result = await run(
    "git",
    [
      "diff",
      "--binary",
      "--no-color",
      "--no-renames",
      "--no-ext-diff",
      options.before,
      options.after,
    ],
    {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.signal !== undefined && { signal: options.signal }),
    },
  );
  return result.code === 0 ? result.stdout : null;
}

export type RewindResult =
  | { outcome: "rewound"; paths: string[] }
  | { outcome: "already-rewound"; paths: string[] }
  | { outcome: "conflict"; conflicts: string[] }
  | { outcome: "unavailable"; reason: string };

/**
 * Reverse-apply a run's own patch to its workspace, or refuse.
 *
 * **All or nothing.** `git apply` without `--reject` checks every hunk before
 * writing any, so a rewind that cannot finish leaves the tree exactly as it
 * was. A half-reverted tree is worse than a bad commit, because the bad commit
 * is at least in the log.
 *
 * Refusals name the paths, file by file. Parsing `git apply`'s stderr would be
 * shorter and wrong on a machine with a different `LANG` — the reason
 * `parseNumstat` exists — so when the whole patch will not reverse, each
 * file's section is checked alone and the ones that fail are named. Only on
 * the failure path; a clean rewind costs one check and one apply.
 *
 * "Already rewound" is told apart from "conflict" by checking whether the
 * patch would apply *forwards*: if it would, the tree is where it was before
 * the run, which is what a second rewind of the same run looks like.
 *
 * The working tree only. The index is left alone except for files the run
 * *created*: the rewind deletes them, and their intent-to-add marker from
 * {@link diffWorkspace} would otherwise show up as a deletion in `git status`.
 */
export async function rewindPatch(options: {
  cwd: string;
  patch: string;
  /** Check only; write nothing. */
  dryRun?: boolean;
  timeoutMs?: number;
}): Promise<RewindResult> {
  const { cwd } = options;
  if (!(await isGitRepo(cwd))) {
    return {
      outcome: "unavailable",
      reason: `${cwd} is not a git repository, so the patch cannot be applied there.`,
    };
  }
  const sections = splitSections(options.patch);
  const paths = sections.map((section) => section.path);
  if (sections.length === 0) return { outcome: "rewound", paths: [] };

  const timeoutMs = options.timeoutMs ?? 60_000;
  const scratch = await mkdtemp(join(tmpdir(), "cuesheet-rewind-"));
  try {
    const apply = async (text: string, args: string[]): Promise<boolean> => {
      const file = join(scratch, "patch");
      await writeFile(file, text, "utf8");
      const result = await run("git", ["apply", ...args, file], {
        cwd,
        timeoutMs,
      });
      return result.code === 0;
    };

    if (!(await apply(options.patch, ["-R", "--check"]))) {
      if (await apply(options.patch, ["--check"])) {
        return { outcome: "already-rewound", paths };
      }
      const conflicts: string[] = [];
      for (const section of sections) {
        if (!(await apply(section.text, ["-R", "--check"]))) {
          conflicts.push(section.path);
        }
      }
      // Every section can reverse alone while the whole cannot. Still a
      // refusal, and then every path is the honest answer.
      return {
        outcome: "conflict",
        conflicts: conflicts.length > 0 ? conflicts : paths,
      };
    }

    if (options.dryRun === true) return { outcome: "rewound", paths };
    if (!(await apply(options.patch, ["-R"]))) {
      // Checked a moment ago and something moved in between. Still atomic.
      return { outcome: "conflict", conflicts: paths };
    }

    const created = sections
      .filter((section) => section.created)
      .map((section) => section.path);
    if (created.length > 0) {
      await run(
        "git",
        ["rm", "--cached", "--quiet", "--ignore-unmatch", "--", ...created],
        { cwd, timeoutMs },
      ).catch(() => undefined);
    }
    return { outcome: "rewound", paths };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Per-file sections of a `--no-renames` patch: the text, the path, and
 * whether the run created the file.
 *
 * Not `core`'s `splitPatch`, which serves a reviewer and decodes quoted paths
 * for globbing. The harness depends on `core` for types only, and this needs
 * nothing but the `diff --git` boundary.
 */
function splitSections(
  patch: string,
): { path: string; text: string; created: boolean }[] {
  const sections: { path: string; text: string; created: boolean }[] = [];
  let current = "";
  const flush = (): void => {
    if (current === "") return;
    const plus = /^\+\+\+ "?b\/(.*?)"?\t?\r?$/m.exec(current);
    const minus = /^--- "?a\/(.*?)"?\t?\r?$/m.exec(current);
    const header = /^diff --git "?a\/.*?"? "?b\/(.*?)"?\r?$/m.exec(current);
    sections.push({
      path: plus?.[1] ?? minus?.[1] ?? header?.[1] ?? "",
      text: current,
      created: /^new file mode /m.test(current),
    });
    current = "";
  };
  for (const line of patch.split(/(?<=\n)/)) {
    if (line.startsWith("diff --git ")) flush();
    current += line;
  }
  flush();
  return sections;
}
