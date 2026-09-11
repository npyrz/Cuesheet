import { mkdtemp, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { diffWorkspace, EMPTY_DIFF, isGitRepo, parseNumstat } from "./git.js";
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
