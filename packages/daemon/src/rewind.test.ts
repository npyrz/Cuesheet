/**
 * Step 60, end to end: a run makes a mess, and the record undoes it.
 *
 * Every workspace here starts **already dirty** — an uncommitted edit and an
 * untracked file of the operator's — because that is the case the plan's own
 * premise got wrong. `diff.patch` holds that dirt as well as the run's work;
 * a rewind built on it would have taken the operator's edits with it.
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHarnessRegistry,
  createMockHarness,
  type Harness,
} from "@cuesheet/harness";
import type { HostEnv } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";
import type { RunDetailResponse } from "./store.js";

const exec = promisify(execFile);

// Real `git` several times per run plus a daemon per test; a budget for a
// loaded machine, as in `gate-run.test.ts`. Every wait is on a condition.
vi.setConfig({ testTimeout: 30_000 });

let env: HostEnv;
let home: string;
let workspace: string;
let daemon: DaemonHandle | null = null;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: workspace });
  return stdout;
}

/** Text with line endings normalised; see `git.test.ts` for why. */
async function read(file: string): Promise<string | null> {
  const text = await readFile(path.join(workspace, file), "utf8").catch(
    () => null,
  );
  return text === null ? null : text.replaceAll("\r\n", "\n");
}

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-rewind-")));
  env = { platform: process.platform, homedir: home };
  workspace = path.join(home, "project");
  await mkdir(workspace);
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await writeFile(path.join(workspace, "README.md"), "hello\n", "utf8");
  await git("add", "-A");
  await git("commit", "-qm", "init");
  // The operator's own uncommitted work, present before any run.
  await writeFile(path.join(workspace, "README.md"), "hello\nmine\n", "utf8");
  await writeFile(path.join(workspace, "notes.txt"), "my notes\n", "utf8");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

/** An engineer that edits a tracked file and creates one — a mess. */
function messyEngineer(gate?: Promise<void>): Harness {
  return {
    ...createMockHarness({ standby: false }),
    async run(ctx) {
      await gate;
      const current = await ctx.workspace.read("README.md");
      await ctx.workspace.write("README.md", `${current}the run was here\n`);
      await ctx.workspace.write("src/broken.ts", "export const x = ;\n");
      return { status: "done" };
    },
  };
}

async function boot(harness: Harness, where = workspace): Promise<string> {
  await writeFile(
    path.join(where, "cuesheet.toml"),
    [
      "[[station]]",
      'id = "maker"',
      'harness = "mock"',
      'role = "engineer"',
      // Absolute: a relative workspace resolves against the daemon's cwd.
      `workspace = ${JSON.stringify(where)}`,
      'paths = ["**"]',
      'deny = [".git/**", "cuesheet.toml"]',
      "",
    ].join("\n"),
    "utf8",
  );
  // Committed, so the config file itself is not part of anyone's dirt.
  if (where === workspace) {
    await git("add", "cuesheet.toml");
    await git("commit", "-qm", "config");
  }
  daemon = await startDaemon({
    port: 0,
    env,
    cwd: where,
    writeLockFile: false,
    ...harnessRuntime({ registry: createHarnessRegistry([harness]) }),
  });
  const project = daemon.defaultProject;
  if (!project) throw new Error("no project");
  return `${daemon.url}/projects/${project.project.id}`;
}

async function start(base: string): Promise<string> {
  const response = await fetch(`${base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "make a mess" }),
  });
  expect(response.status).toBe(202);
  return ((await response.json()) as { runId: string }).runId;
}

async function finished(
  base: string,
  runId: string,
): Promise<RunDetailResponse> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const detail = (await (
      await fetch(`${base}/runs/${runId}`)
    ).json()) as RunDetailResponse;
    if (detail.run.finishedAt) return detail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} never finished`);
}

async function rewind(
  base: string,
  runId: string,
  dryRun = false,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/runs/${runId}/rewind`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dryRun }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("rewind", () => {
  it("undoes a run that made a mess, from the record, and only that run", async () => {
    const base = await boot(messyEngineer());
    const runId = await start(base);
    const detail = await finished(base, runId);
    expect(detail.hasRewind).toBe(true);
    expect(await read("src/broken.ts")).not.toBeNull();

    // The old patch is the whole dirty workspace — the operator's edit and
    // their untracked notes are in it. That is why rewind does not use it.
    const workspaceDiff = await (
      await fetch(`${base}/runs/${runId}/diff`)
    ).text();
    expect(workspaceDiff).toContain("notes.txt");

    // A check writes nothing.
    const checked = await rewind(base, runId, true);
    expect(checked.status).toBe(200);
    expect(checked.body).toMatchObject({ dryRun: true });
    expect(await read("src/broken.ts")).not.toBeNull();

    const undone = await rewind(base, runId);
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({
      outcome: "rewound",
      paths: ["README.md", "src/broken.ts"],
    });
    expect(await read("src/broken.ts")).toBeNull();
    // The operator's work, untouched.
    expect(await read("README.md")).toBe("hello\nmine\n");
    expect(await read("notes.txt")).toBe("my notes\n");
    // `notes.txt` reads ` A`, not `??`: every run's workspace diff marks
    // untracked files intent-to-add (see `diffWorkspace`), and that marker is
    // older than this step and not the run's change to undo. Its content is
    // what matters, and it is intact above.
    const status = (await git("status", "--porcelain"))
      .split("\n")
      .filter((line) => line !== "")
      .sort();
    expect(status).toEqual([" A notes.txt", " M README.md"]);

    // Twice is a different answer from a conflict.
    const again = await rewind(base, runId);
    expect(again.status).toBe(409);
    expect(again.body["outcome"]).toBe("already-rewound");
  });

  it("refuses when the tree moved under the patch, names the paths, and changes nothing", async () => {
    const base = await boot(messyEngineer());
    const runId = await start(base);
    await finished(base, runId);
    // The operator fixes the broken file by hand afterwards.
    await writeFile(
      path.join(workspace, "src", "broken.ts"),
      "export const x = 1;\n",
      "utf8",
    );

    const refused = await rewind(base, runId);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      outcome: "conflict",
      conflicts: ["src/broken.ts"],
    });
    expect(String(refused.body["error"])).toContain("src/broken.ts");
    // Atomic: README.md could have been reverted on its own, and was not.
    expect(await read("README.md")).toBe("hello\nmine\nthe run was here\n");
    expect(await read("src/broken.ts")).toBe("export const x = 1;\n");
  });

  it("will not rewrite the workspace under a run that is still going", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const harness: Harness = {
      ...messyEngineer(),
      async run(ctx) {
        calls += 1;
        // The first run finishes; the second holds the queue.
        return messyEngineer(calls === 1 ? undefined : gate).run(ctx);
      },
    };
    const base = await boot(harness);
    const first = await start(base);
    await finished(base, first);
    const second = await start(base);

    const refusedFinished = await rewind(base, first);
    expect(refusedFinished.status).toBe(409);
    expect(String(refusedFinished.body["error"])).toContain(second);

    const refusedActive = await rewind(base, second);
    expect(refusedActive.status).toBe(409);

    release();
    await finished(base, second);
  });

  it("explains why a run outside a repository cannot be rewound", async () => {
    const plain = path.join(home, "plain");
    await mkdir(plain);
    const base = await boot(messyEngineer(), plain);
    const runId = await start(base);
    const detail = await finished(base, runId);
    expect(detail.hasRewind).toBe(false);

    const refused = await rewind(base, runId);
    expect(refused.status).toBe(409);
    expect(String(refused.body["error"])).toContain("git repository");
  });
});
