import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  diffSnapshots,
  diffWorkspace,
  EMPTY_DIFF,
  isGitRepo,
  parseNumstat,
  rewindPatch,
  snapshotWorkspace,
} from "./git.js";
import { run } from "./spawn.js";

let repo: string;

async function git(...args: string[]): Promise<void> {
  await run("git", args, { cwd: repo, timeoutMs: 20_000 });
}

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-git-")));
  await git("init", "-q", ".");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(repo, "README.md"), "hello\n", "utf8");
  await git("add", "-A");
  await git("commit", "-qm", "init");
});

describe("parseNumstat", () => {
  it("sums insertions and deletions per file", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n")).toEqual({
      filesChanged: 2,
      insertions: 13,
      deletions: 1,
    });
  });

  it("counts a binary file as changed but contributes no lines", () => {
    // `git` reports `-` for both columns on a binary; parsing that as NaN and
    // adding it would poison the whole total.
    expect(parseNumstat("-\t-\tlogo.png\n2\t0\tsrc/a.ts\n")).toEqual({
      filesChanged: 2,
      insertions: 2,
      deletions: 0,
    });
  });

  it("tolerates \\r\\n and blank lines", () => {
    expect(parseNumstat("1\t0\ta.ts\r\n\r\n")).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
  });

  it("is empty for no output", () => {
    expect(parseNumstat("")).toEqual(EMPTY_DIFF.stat);
  });
});

describe("diffWorkspace", () => {
  it("includes a newly created file", async () => {
    // The bug this exists to prevent: `git diff` alone reports only tracked
    // files, so a run whose entire contribution is a new file produces an
    // empty patch and looks like it did nothing.
    await writeFile(path.join(repo, "greeting.txt"), "hello\n", "utf8");
    const diff = await diffWorkspace({ cwd: repo });
    expect(diff.patch).toContain("greeting.txt");
    expect(diff.patch).toContain("+hello");
    expect(diff.stat.filesChanged).toBe(1);
    expect(diff.stat.insertions).toBe(1);
  }, 30_000);

  it("includes a modification to a tracked file", async () => {
    await writeFile(path.join(repo, "README.md"), "hello\nworld\n", "utf8");
    const diff = await diffWorkspace({ cwd: repo });
    expect(diff.patch).toContain("+world");
    expect(diff.stat).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 0,
    });
  }, 30_000);

  it("is empty when nothing changed", async () => {
    const diff = await diffWorkspace({ cwd: repo });
    expect(diff).toEqual(EMPTY_DIFF);
  }, 30_000);

  it("resolves to an empty diff outside a repository, rather than throwing", async () => {
    // A missing `.git` is a reason to have no diff, not a reason to fail a run
    // that already did its work.
    const bare = await mkdtemp(path.join(tmpdir(), "cuesheet-nogit-"));
    await expect(diffWorkspace({ cwd: bare })).resolves.toEqual(EMPTY_DIFF);
  }, 30_000);
});

describe("isGitRepo", () => {
  it("is true inside a repo and false outside one", async () => {
    expect(await isGitRepo(repo)).toBe(true);
    const bare = await mkdtemp(path.join(tmpdir(), "cuesheet-nogit-"));
    expect(await isGitRepo(bare)).toBe(false);
  }, 30_000);
});

/**
 * Step 60. Every case here is the operator's real situation in miniature: a
 * workspace that was already dirty before the run, which is the case the
 * old `diff.patch` got wrong.
 */
describe("snapshots and rewind", () => {
  /**
   * File text with line endings normalised. A rewind writes through git, so
   * it restores content the way git checks it out: on a machine with
   * `core.autocrlf=true` — Windows, including the one this was written on — a
   * file the run touched comes back CRLF even if it had been LF. That is
   * `git checkout -- file` semantics, chosen over forcing the setting off,
   * which would disagree with blobs the operator's own index already cached.
   */
  async function read(file: string): Promise<string | null> {
    const text = await readFile(path.join(repo, file), "utf8").catch(
      () => null,
    );
    return text === null ? null : text.replaceAll("\r\n", "\n");
  }

  /** What a run does: snapshot, change things, snapshot, diff. */
  async function runChanges(change: () => Promise<void>): Promise<string> {
    const before = await snapshotWorkspace({ cwd: repo });
    await change();
    const after = await snapshotWorkspace({ cwd: repo });
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    const patch = await diffSnapshots({
      cwd: repo,
      before: before as string,
      after: after as string,
    });
    return patch ?? "";
  }

  it("captures only what happened between the snapshots", async () => {
    // Dirt from before the run: an edit and an untracked file.
    await writeFile(path.join(repo, "README.md"), "hello\nmine\n", "utf8");
    await writeFile(path.join(repo, "notes.txt"), "my notes\n", "utf8");

    const patch = await runChanges(async () => {
      await writeFile(path.join(repo, "made.ts"), "export {};\n", "utf8");
    });

    expect(patch).toContain("made.ts");
    expect(patch).not.toContain("notes.txt");
    expect(patch).not.toContain("mine");
  });

  it("leaves the operator's index exactly as it was", async () => {
    await writeFile(path.join(repo, "staged.txt"), "staged\n", "utf8");
    await git("add", "staged.txt");
    const before = await run("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
    });

    await snapshotWorkspace({ cwd: repo });
    await writeFile(path.join(repo, "untracked.txt"), "x\n", "utf8");
    await snapshotWorkspace({ cwd: repo });

    const after = await run("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
    });
    expect(after.stdout).toBe(before.stdout);
    const status = await run("git", ["status", "--porcelain"], { cwd: repo });
    expect(status.stdout).toContain("?? untracked.txt");
  });

  it("undoes a run and only the run, keeping earlier dirt", async () => {
    await writeFile(path.join(repo, "README.md"), "hello\nmine\n", "utf8");
    const patch = await runChanges(async () => {
      await writeFile(path.join(repo, "README.md"), "hello\nmine\nrun\n");
      await writeFile(path.join(repo, "made.ts"), "export {};\n", "utf8");
    });
    // The workspace diff marks new files intent-to-add, as a run's diff
    // would have; the rewind must clean that up too.
    await diffWorkspace({ cwd: repo });

    const result = await rewindPatch({ cwd: repo, patch });
    expect(result).toEqual({
      outcome: "rewound",
      paths: ["README.md", "made.ts"],
    });
    expect(await read("README.md")).toBe("hello\nmine\n");
    expect(await read("made.ts")).toBeNull();
    const status = await run("git", ["status", "--porcelain"], { cwd: repo });
    expect(status.stdout.trim()).toBe("M README.md");
  });

  it("refuses when the tree moved under the patch, naming the paths, and changes nothing", async () => {
    const patch = await runChanges(async () => {
      await writeFile(path.join(repo, "README.md"), "hello\nrun\n", "utf8");
      await writeFile(path.join(repo, "kept.ts"), "export {};\n", "utf8");
    });
    // The operator edits the run's file afterwards.
    await writeFile(path.join(repo, "README.md"), "rewritten\n", "utf8");

    const result = await rewindPatch({ cwd: repo, patch });
    expect(result).toEqual({ outcome: "conflict", conflicts: ["README.md"] });
    // All or nothing: the file that *could* have been reverted was not.
    expect(await read("kept.ts")).toBe("export {};\n");
    expect(await read("README.md")).toBe("rewritten\n");
  });

  it("says a second rewind is a second rewind, not a conflict", async () => {
    const patch = await runChanges(async () => {
      await writeFile(path.join(repo, "README.md"), "hello\nrun\n", "utf8");
    });
    expect((await rewindPatch({ cwd: repo, patch })).outcome).toBe("rewound");
    expect((await rewindPatch({ cwd: repo, patch })).outcome).toBe(
      "already-rewound",
    );
  });

  it("checks without writing on a dry run", async () => {
    const patch = await runChanges(async () => {
      await writeFile(path.join(repo, "README.md"), "hello\nrun\n", "utf8");
    });
    const result = await rewindPatch({ cwd: repo, patch, dryRun: true });
    expect(result.outcome).toBe("rewound");
    expect(await read("README.md")).toBe("hello\nrun\n");
  });

  it("reverses a binary change and a deletion", async () => {
    await writeFile(path.join(repo, "logo.bin"), Buffer.from([0, 1, 2, 255]));
    await git("add", "logo.bin");
    await git("commit", "-qm", "logo");
    const patch = await runChanges(async () => {
      await writeFile(path.join(repo, "logo.bin"), Buffer.from([9, 9, 0, 9]));
      await rm(path.join(repo, "README.md"));
    });

    expect((await rewindPatch({ cwd: repo, patch })).outcome).toBe("rewound");
    expect([...(await readFile(path.join(repo, "logo.bin")))]).toEqual([
      0, 1, 2, 255,
    ]);
    expect(await read("README.md")).toBe("hello\n");
  });

  it("has nothing to snapshot outside a repository", async () => {
    const plain = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-plain-")),
    );
    expect(await snapshotWorkspace({ cwd: plain })).toBeNull();
    expect(
      (await rewindPatch({ cwd: plain, patch: "diff --git a/x b/x\n" }))
        .outcome,
    ).toBe("unavailable");
  });
});
