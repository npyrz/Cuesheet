/**
 * Step 50's contract is Git's contract, exercised against a real bare remote.
 * A fake transport could prove method calls; it cannot prove that two clones
 * converge or that Git leaves both sides of a textual conflict on disk.
 */
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, which } from "@cuesheet/harness";
import { createCommonsStore, type CommonsStore } from "./commons.js";
import { startDaemon, type DaemonHandle } from "./server.js";

let home: string;
let remote: string;
let git: string | null;
let daemon: DaemonHandle | null;

/**
 * These tests are slow because what they exercise is slow, not because they
 * wait on anything: one `pull` is two dozen `git` invocations, and the
 * conflict test drives three checkouts through a hundred process spawns.
 * Spawning is the expensive part on Windows, where CI ran this file for 13s
 * and two of these tipped over Vitest's 5s default. So the budget is stated
 * rather than left at a default meant for pure functions — a ceiling a real
 * hang still hits, not a sleep.
 *
 * Set here rather than per `it`, because the third argument to `it` makes
 * Prettier expand the call and re-indent every test body in the file.
 */
vi.setConfig({ testTimeout: 60_000 });

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-sync-")));
  remote = path.join(home, "remote.git");
  git = await which("git");
  daemon = null;
  if (git !== null) {
    const initialized = await run(git, ["init", "--bare", "--quiet", remote], {
      cwd: home,
    });
    expect(initialized.code).toBe(0);
  }
});

afterEach(async () => {
  await daemon?.close();
  // `maxRetries` because Windows will not unlink a file a process still has
  // open, and a `git` that has just exited can hold its pack a moment longer.
  // Without it the teardown fails with EBUSY and reports it as a second,
  // unrelated-looking failure stacked on top of the real one.
  await rm(home, { recursive: true, force: true, maxRetries: 10 });
});

function checkout(name: string): CommonsStore {
  return createCommonsStore({ root: path.join(home, name) });
}

describe("Commons sync", () => {
  it("tracks the existing remote branch when an older checkout uses another name", async () => {
    if (git === null) return;
    const modern = checkout("modern");
    await modern.configureSync(remote);
    await modern.write({ id: "first", title: "First", body: "From main." });
    await modern.push();

    const legacy = checkout("legacy");
    await legacy.configureSync(remote);
    const renamed = await run(
      git,
      ["symbolic-ref", "HEAD", "refs/heads/master"],
      { cwd: legacy.root },
    );
    expect(renamed.code).toBe(0);
    expect((await legacy.pull()).outcome).toBe("pulled");
    await legacy.write({
      id: "second",
      title: "Second",
      body: "From the old branch name.",
    });
    await legacy.push();
    await modern.pull();
    expect((await modern.get("second"))?.body).toBe(
      "From the old branch name.",
    );
  });

  it("never returns HTTPS credentials from sync status", async () => {
    if (git === null) return;
    const store = checkout("redaction");
    const status = await store.configureSync(
      "https://operator:secret@example.invalid/commons.git",
    );
    expect(status.remote).toBe("https://***@example.invalid/commons.git");
  });

  it("converges two checkouts and leaves a conflicting edit for a human", async () => {
    if (git === null) return;
    const one = checkout("one");
    const two = checkout("two");
    await Promise.all([one.configureSync(remote), two.configureSync(remote)]);

    await one.write({
      id: "shared-rule",
      title: "Shared rule",
      body: "Start from the same fact.",
    });
    expect((await one.push()).outcome).toBe("pushed");
    expect((await two.pull()).outcome).toBe("pulled");
    expect((await two.get("shared-rule"))?.body).toBe(
      "Start from the same fact.",
    );

    await one.write({
      id: "shared-rule",
      title: "Shared rule",
      body: "The first machine kept this wording.",
    });
    await two.write({
      id: "shared-rule",
      title: "Shared rule",
      body: "The second machine chose another wording.",
    });
    expect((await two.push()).outcome).toBe("pushed");

    const conflict = await one.pull();
    expect(conflict.outcome).toBe("conflict");
    expect(conflict.conflicts).toEqual(["shared-rule.md"]);
    const conflicted = await readFile(
      path.join(one.root, "shared-rule.md"),
      "utf8",
    );
    expect(conflicted).toContain("The first machine kept this wording.");
    expect(conflicted).toContain("The second machine chose another wording.");
    expect(conflicted).toContain("<<<<<<<");

    // Writing the resolution replaces the conflict markers but deliberately
    // cannot make a normal fact commit while MERGE_HEAD exists. The explicit
    // continuation below is the human-controlled point that records the merge.
    const resolution = await one.write({
      id: "shared-rule",
      title: "Shared rule",
      body: "Keep both machines' useful conclusions.",
    });
    expect(resolution.committed).toBe(false);
    expect((await one.continueSync()).outcome).toBe("resolved");
    expect((await one.push()).outcome).toBe("pushed");
    expect((await two.pull()).outcome).toBe("pulled");
    expect((await two.get("shared-rule"))?.body).toBe(
      "Keep both machines' useful conclusions.",
    );
  });

  it("moves a Claude-authored fact into Codex context through only the remote", async () => {
    if (git === null) return;
    const first = checkout("first-machine");
    await first.configureSync(remote);
    await first.write({
      id: "portable-memory",
      title: "Portable memory",
      body: "The queue belongs to the project runtime.",
      station: "claude-code",
      run: "20260922T120000000Z-0001",
    });
    await first.push();

    const secondHome = path.join(home, "second-home");
    await mkdir(secondHome);
    const second = createCommonsStore({
      root: path.join(secondHome, ".cuesheet", "commons"),
    });
    daemon = await startDaemon({
      port: 0,
      env: { platform: process.platform, homedir: secondHome },
      cwd: secondHome,
      commons: second,
      contextFiles: () => [{ path: ".codex/AGENTS.md", scope: "user" }],
      writeLockFile: false,
    });

    const configured = await fetch(`${daemon.url}/commons/sync`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remote }),
    });
    expect(configured.status).toBe(200);
    const pulled = await fetch(`${daemon.url}/commons/sync/pull`, {
      method: "POST",
    });
    expect(pulled.status).toBe(200);
    expect((await pulled.json()) as { outcome: string }).toMatchObject({
      outcome: "pulled",
    });

    const context = await readFile(
      path.join(secondHome, ".codex", "AGENTS.md"),
      "utf8",
    );
    expect(context).toContain("## Portable memory");
    expect(context).toContain("The queue belongs to the project runtime.");
  });
});
