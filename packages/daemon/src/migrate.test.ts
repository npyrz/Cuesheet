/**
 * Step 33's done-when, as far as a committed test can prove it.
 *
 * "Verified by upgrading a real alpha profile, not a fixture" is deliberately
 * not claimed here: CI cannot build the `v0.1.0-alpha` tag, so the real upgrade
 * is a recorded one-off in PLAN-STEP.MD's retrospective. What this file holds is
 * everything that would silently regress afterwards — that the alpha layout is
 * *recognised*, that its Stations survive, that its run records are still
 * readable and still attributed, and that the whole move lands before the
 * runtime that reconciles the store is ever built.
 *
 * The legacy history is written by `createFileRunStore` pointed at
 * `runsDir(env)` rather than by hand, because that *is* what the alpha build
 * wrote: one store, one root, `~/.cuesheet/runs`. Hand-rolling the JSON would
 * be asserting against this file's idea of the old format instead of the old
 * format.
 */
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  configDir,
  configFile,
  projectConfigFile,
  projectRunsDir,
  runsDir,
  type HostEnv,
  type ListedProject,
  type Run,
} from "@cuesheet/core";
import { createFileRunStore } from "./store.js";
import { startDaemon, type DaemonHandle } from "./server.js";
import type { StationsResponse } from "./stations.js";

let home: string;
let cwd: string;
let env: HostEnv;
let daemon: DaemonHandle;

beforeEach(async () => {
  home = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-up-home-")),
  );
  // A cwd with no config, which is the packaged app's situation and makes the
  // point that nothing here is bootstrapped from the working directory.
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-up-cwd-")));
  env = { platform: process.platform, homedir: home };
  await mkdir(configDir(env), { recursive: true });
});

afterEach(async () => {
  await daemon?.close();
  await rm(home, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

/** The repository an alpha user's Stations pointed at. */
async function alphaWorkspace(): Promise<string> {
  const dir = path.join(home, "code", "api");
  await mkdir(dir, { recursive: true });
  return dir;
}

/** `~/.cuesheet/cuesheet.toml` — the only config an alpha install had. */
async function alphaConfig(ws: string): Promise<void> {
  await writeFile(
    configFile(env),
    `[desk]
name = "Alpha desk"

[[station]]
id = "opus"
harness = "claude-code"
role = "engineer"
workspace = ${JSON.stringify(ws)}

[[station]]
id = "review"
harness = "codex"
role = "reviewer"
workspace = ${JSON.stringify(ws)}
`,
    "utf8",
  );
}

/**
 * Runs written the way alpha wrote them: one store at `~/.cuesheet/runs`.
 * Returns the finished run and one deliberately left `running`, as a daemon
 * killed mid-run would have left it.
 */
async function alphaRuns(ws: string): Promise<{ done: Run; killed: Run }> {
  const store = createFileRunStore({ root: runsDir(env) });
  const done = await store.create({
    prompt: "add a health route",
    workspace: ws,
    stationIds: ["opus"],
  });
  await store.update(done.id, { status: "running" });
  const finished = await store.finish(done.id, {
    status: "done",
    cost: { tokensIn: 11, tokensOut: 22 },
  });

  const killed = await store.create({
    prompt: "the one the crash ate",
    workspace: ws,
    stationIds: ["review"],
  });
  await store.update(killed.id, { status: "running" });

  return { done: finished, killed };
}

async function boot(): Promise<void> {
  daemon = await startDaemon({ port: 0, cwd, env, writeLockFile: false });
}

function base(): string {
  const runtime = daemon.defaultProject;
  if (!runtime) throw new Error("the daemon bootstrapped no project");
  return `${daemon.url}/projects/${runtime.project.id}`;
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

it("opens an alpha profile as project #1, rooted where the code is", async () => {
  const ws = await alphaWorkspace();
  await alphaConfig(ws);
  await boot();

  const { projects } = await get<{ projects: ListedProject[] }>(
    `${daemon.url}/projects`,
  );
  expect(projects).toHaveLength(1);
  expect(projects[0]?.root).toBe(ws);
  expect(projects[0]?.status).toBe("ok");
  // Not `~/.cuesheet`, which is what Step 32 left behind and this step is for.
  expect(projects[0]?.root).not.toBe(configDir(env));
});

it("keeps the alpha Stations intact, at the project's private config path", async () => {
  const ws = await alphaWorkspace();
  await alphaConfig(ws);
  await boot();

  const stations = await get<StationsResponse>(`${base()}/stations`);
  expect(stations.stations.map((view) => view.station.id)).toEqual([
    "opus",
    "review",
  ]);
  // The repo was not written into — the promise that using Cuesheet on someone
  // else's checkout leaves no trace in it.
  expect(stations.sourcePath).toBe(
    projectConfigFile(daemon.defaultProject!.project.id, env),
  );
  await expect(stat(path.join(ws, "cuesheet.toml"))).rejects.toThrow();
});

it("carries every run record over, still readable and still attributed", async () => {
  const ws = await alphaWorkspace();
  await alphaConfig(ws);
  const { done } = await alphaRuns(ws);
  await boot();

  const { runs } = await get<{ runs: Run[] }>(`${base()}/runs`);
  expect(runs).toHaveLength(2);

  const carried = runs.find((run) => run.id === done.id);
  expect(carried).toBeDefined();
  expect(carried?.prompt).toBe("add a health route");
  // Attribution is the part a copy could quietly drop.
  expect(carried?.workspace).toBe(ws);
  expect(carried?.stationIds).toEqual(["opus"]);
  expect(carried?.cost).toEqual({ tokensIn: 11, tokensOut: 22 });

  const detail = await get<{ run: Run; events: unknown[] }>(
    `${base()}/runs/${done.id}`,
  );
  expect(detail.run.id).toBe(done.id);
});

/**
 * The ordering assertion, and the reason the moves happen before
 * `runtimes.get`. A runtime reconciles its store the first time it is touched
 * and never again; history moved in afterwards would keep a run the alpha
 * daemon was killed during marked `running` with nothing left to correct it.
 */
it("reconciles a run the alpha daemon was killed during", async () => {
  const ws = await alphaWorkspace();
  await alphaConfig(ws);
  const { killed } = await alphaRuns(ws);
  await boot();

  const detail = await get<{ run: Run }>(`${base()}/runs/${killed.id}`);
  expect(detail.run.status).toBe("interrupted");
});

it("moves the profile rather than copying it — one source of truth after", async () => {
  const ws = await alphaWorkspace();
  await alphaConfig(ws);
  await alphaRuns(ws);
  await boot();

  await expect(stat(configFile(env))).rejects.toThrow();
  await expect(stat(runsDir(env))).rejects.toThrow();
  expect(
    await readFile(
      projectConfigFile(daemon.defaultProject!.project.id, env),
      "utf8",
    ),
  ).toContain("Alpha desk");
});

it("survives a restart, and comes back up on the same project", async () => {
  const ws = await alphaWorkspace();
  await alphaConfig(ws);
  const { done } = await alphaRuns(ws);
  await boot();
  const first = daemon.defaultProject!.project.id;
  await daemon.close();

  await boot();
  expect(daemon.defaultProject!.project.id).toBe(first);
  const { runs } = await get<{ runs: Run[] }>(`${base()}/runs`);
  expect(runs.map((run) => run.id)).toContain(done.id);
  // The second boot must not re-run anything: the runs are already home.
  expect(await stat(projectRunsDir(first, env))).toBeTruthy();
});

/**
 * An alpha user whose config lived in their repo was already handled correctly
 * by Step 32, and this step must not have moved it. The history still has to
 * come across, because there was only ever one run store.
 */
it("leaves a repo-rooted config where it is, but still brings the history", async () => {
  const ws = await alphaWorkspace();
  await writeFile(
    path.join(ws, "cuesheet.toml"),
    '[[station]]\nid = "opus"\nharness = "claude-code"\nrole = "engineer"\n',
    "utf8",
  );
  cwd = ws;
  const { done } = await alphaRuns(ws);
  await boot();

  const stations = await get<StationsResponse>(`${base()}/stations`);
  expect(stations.sourcePath).toBe(path.join(ws, "cuesheet.toml"));

  const { runs } = await get<{ runs: Run[] }>(`${base()}/runs`);
  expect(runs.map((run) => run.id)).toContain(done.id);
});

/**
 * A leftover global config next to a repo config, which is a realistic alpha
 * profile rather than a contrived one: alpha's `addStation` fell back to
 * `~/.cuesheet/cuesheet.toml` whenever the loader had resolved nothing, and a
 * Finder-launched app always had. The repo config is what loads, so the global
 * one is not this project's to move — an earlier draft relocated it under a
 * project whose repo config shadows it, where nothing would have read it again.
 */
it("does not move a global config that is not the one the project loads", async () => {
  const ws = await alphaWorkspace();
  await writeFile(
    path.join(ws, "cuesheet.toml"),
    '[[station]]\nid = "opus"\nharness = "claude-code"\nrole = "engineer"\n',
    "utf8",
  );
  await alphaConfig(ws);
  cwd = ws;
  const { done } = await alphaRuns(ws);
  await boot();

  const stations = await get<StationsResponse>(`${base()}/stations`);
  expect(stations.sourcePath).toBe(path.join(ws, "cuesheet.toml"));
  // Untouched, and still readable where the user left it.
  expect(await readFile(configFile(env), "utf8")).toContain("Alpha desk");
  // The history has only one home either way, so it still comes across.
  const { runs } = await get<{ runs: Run[] }>(`${base()}/runs`);
  expect(runs.map((run) => run.id)).toContain(done.id);
});

/**
 * The conservative branch, and it has to stay conservative: with no evidence
 * about where the code is, the project is rooted at `~/.cuesheet` and the
 * legacy config stays put — where it is still the first thing the loader looks
 * at, so the Stations remain live.
 */
it("roots at ~/.cuesheet when no Station says where the code is", async () => {
  await writeFile(
    configFile(env),
    '[[station]]\nid = "opus"\nharness = "claude-code"\nrole = "engineer"\n',
    "utf8",
  );
  await boot();

  expect(daemon.defaultProject!.project.root).toBe(configDir(env));
  const stations = await get<StationsResponse>(`${base()}/stations`);
  expect(stations.stations.map((view) => view.station.id)).toEqual(["opus"]);
  expect(stations.sourcePath).toBe(configFile(env));
});

it("bootstraps nothing on a fresh install, and moves nothing", async () => {
  await boot();
  expect(daemon.defaultProject).toBeNull();
  const { projects } = await get<{ projects: ListedProject[] }>(
    `${daemon.url}/projects`,
  );
  expect(projects).toEqual([]);
});
