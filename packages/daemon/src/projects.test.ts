/**
 * Step 32's done-when: two projects, one daemon, no leakage.
 *
 * The isolation assertions are the point of the file. Everything else in the
 * daemon's suite runs with exactly one project and would keep passing if the
 * scoping were cosmetic.
 */
import {
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  projectRunsDir,
  type HostEnv,
  type ListedProject,
  type Project,
  type RunEvent,
} from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import type { RunExecutor } from "./executor.js";
import type { StationsResponse } from "./stations.js";

let env: HostEnv;
let home: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-mp-")));
  env = { platform: process.platform, homedir: home };
});

afterEach(async () => {
  await daemon?.close();
});

/** A project folder with its own config, naming its own Station. */
async function projectFolder(name: string, stationId: string): Promise<string> {
  const root = path.join(home, name);
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "cuesheet.toml"),
    `[[station]]
id = "${stationId}"
harness = "claude-code"
role = "engineer"
workspace = ${JSON.stringify(root)}
`,
    "utf8",
  );
  return root;
}

const done: RunExecutor = () =>
  Promise.resolve({
    status: "done" as const,
    cost: { tokensIn: 0, tokensOut: 0 },
    durationMs: 0,
  });

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return (await response.json()) as T;
}

async function open(root: string): Promise<Project> {
  const { project } = await json<{ project: Project }>(
    `${daemon.url}/projects`,
    { method: "POST", body: JSON.stringify({ root }) },
  );
  return project;
}

async function waitFor(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("a daemon with no projects", () => {
  it("answers GET /projects before any project has been opened", async () => {
    // One of Step 32's three done-when clauses, and the reason the daemon does
    // not invent a project for a fresh install: the picker's first render
    // depends on this route answering rather than erroring.
    const cwd = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-nothing-")),
    );
    daemon = await startDaemon({ port: 0, env, cwd, writeLockFile: false });

    expect(daemon.defaultProject).toBeNull();
    expect(
      await json<{ projects: unknown[] }>(`${daemon.url}/projects`),
    ).toEqual({ projects: [] });
  });

  it("never bootstraps from cwd, which is `/` in the packaged app", async () => {
    // The hazard this guards is specific and was nearly shipped: bootstrapping
    // from `process.cwd()` mints a project rooted at the filesystem root under
    // Electron on macOS, permanently, because the main process never chdirs.
    // The bootstrap reads `loadConfig`'s `sourcePath` instead, so a cwd with no
    // config contributes nothing.
    const cwd = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-nocfg-")),
    );
    daemon = await startDaemon({ port: 0, env, cwd, writeLockFile: false });

    const { projects } = await json<{ projects: Project[] }>(
      `${daemon.url}/projects`,
    );
    expect(projects).toEqual([]);
  });
});

describe("two projects at once", () => {
  let api: Project;
  let web: Project;

  beforeEach(async () => {
    const apiRoot = await projectFolder("api", "opus");
    const webRoot = await projectFolder("web", "sonnet");
    daemon = await startDaemon({
      port: 0,
      env,
      cwd: home,
      writeLockFile: false,
      executor: done,
    });
    api = await open(apiRoot);
    web = await open(webRoot);
  });

  it("serves each project its own Stations, from its own config", async () => {
    const a = await json<StationsResponse>(
      `${daemon.url}/projects/${api.id}/stations`,
    );
    const b = await json<StationsResponse>(
      `${daemon.url}/projects/${web.id}/stations`,
    );

    expect(a.stations.map((s) => s.station.id)).toEqual(["opus"]);
    expect(b.stations.map((s) => s.station.id)).toEqual(["sonnet"]);
    // Each read its own `cuesheet.toml`, which is the thing that was one file
    // for the whole daemon before this step.
    expect(a.sourcePath).not.toBe(b.sourcePath);
  });

  it("keeps a run started in one out of the other's list", async () => {
    // The clause that actually proves isolation. Everything else in the suite
    // runs one project and would pass if the scoping were only cosmetic.
    const { runId } = await json<{ runId: string }>(
      `${daemon.url}/projects/${api.id}/runs`,
      { method: "POST", body: JSON.stringify({ prompt: "ship it" }) },
    );
    const runtime = await daemon.projects.get(api.id);
    await runtime!.queue.idle();

    const mine = await json<{ runs: { id: string }[] }>(
      `${daemon.url}/projects/${api.id}/runs`,
    );
    const theirs = await json<{ runs: { id: string }[] }>(
      `${daemon.url}/projects/${web.id}/runs`,
    );

    expect(mine.runs.map((r) => r.id)).toContain(runId);
    expect(theirs.runs).toEqual([]);

    // And the record is not merely hidden from the list — it is not reachable
    // through the other project at all.
    const response = await fetch(
      `${daemon.url}/projects/${web.id}/runs/${runId}`,
    );
    expect(response.status).toBe(404);

    // One database per project, not one keyed by project. This daemon was
    // started with no store of its own, so it is the Step 52 default that
    // wrote these — the isolation property survived the backend change
    // because the root did.
    expect(await readdir(projectRunsDir(api.id, env))).toContain("runs.db");
    expect(await readdir(projectRunsDir(web.id, env))).toContain("runs.db");
  });

  it("does not put one project's events on the other's socket", async () => {
    // A leak here would be invisible to every list-based assertion above: the
    // stores would be separate and the Desk would still render another
    // project's run streaming into a tile.
    const seen: RunEvent[] = [];
    const socket = new WebSocket(
      `${daemon.url.replace("http", "ws")}/projects/${web.id}/ws`,
    );
    socket.on("message", (data) =>
      seen.push(JSON.parse(String(data)) as RunEvent),
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    // Watched on the daemon-wide bus, which sees every project. Waiting for
    // the run to *finish there* is what makes the assertion below meaningful:
    // without it, "the other socket saw nothing" would only mean the events
    // had not been emitted yet.
    const global: RunEvent[] = [];
    const watching = daemon.bus.attach((event) => global.push(event));

    try {
      await json(`${daemon.url}/projects/${api.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ship it" }),
      });
      const runtime = await daemon.projects.get(api.id);
      await runtime!.queue.idle();
      await waitFor("the run to finish on the daemon-wide bus", () =>
        global.some((event) => event.t === "done"),
      );

      expect(global.length).toBeGreaterThan(0);
      expect(seen).toEqual([]);
    } finally {
      watching.unsubscribe();
      socket.close();
    }
  });

  it("mirrors every project into the daemon-wide bus, for the tray", async () => {
    // The other half of the same design: the desktop shell keeps exactly one
    // subscription and must be notified whichever project raised the event.
    const seen: RunEvent[] = [];
    const { unsubscribe } = daemon.bus.attach((event) => seen.push(event));
    try {
      await json(`${daemon.url}/projects/${web.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ prompt: "ship it" }),
      });
      const runtime = await daemon.projects.get(web.id);
      await runtime!.queue.idle();
      await waitFor("a done event on the daemon-wide bus", () =>
        seen.some((event) => event.t === "done"),
      );
    } finally {
      unsubscribe();
    }
  });

  it("gives each project its own store root", async () => {
    const a = await daemon.projects.get(api.id);
    const b = await daemon.projects.get(web.id);
    expect(a).not.toBe(b);
    expect(a!.project.id).not.toBe(b!.project.id);
  });

  it("builds one runtime for concurrent first requests", async () => {
    // Memoized on the promise, not the result. A check-then-create would let
    // two cold requests both reconcile the store and both build a queue over
    // one root — the lost-update shape `projects.json` is serialized against.
    const third = await open(await projectFolder("third", "haiku"));
    const [one, two, three] = await Promise.all([
      daemon.projects.get(third.id),
      daemon.projects.get(third.id),
      daemon.projects.get(third.id),
    ]);
    expect(one).toBe(two);
    expect(two).toBe(three);
  });
});

describe("across a restart", () => {
  it("still knows the project, and reopens the one you were last in", async () => {
    // **Step 31's deferred clause.** Its done-when said a project "survives a
    // daemon restart", and Step 31 could not prove it because it was core-only
    // — what it proved was the mechanism, that a second registry over the same
    // file reads back what the first wrote. This is the criterion itself, and
    // it is discharged here rather than quietly dropped.
    const root = await projectFolder("api", "opus");
    const cwd = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-nocfg-")),
    );

    daemon = await startDaemon({ port: 0, env, cwd, writeLockFile: false });
    const opened = await open(root);
    // Touch it, so it is the most recently opened rather than merely present.
    await fetch(`${daemon.url}/projects/${opened.id}/stations`);
    await daemon.close();

    // A second process over the same home — which is what a relaunch is.
    daemon = await startDaemon({ port: 0, env, cwd, writeLockFile: false });

    const { projects } = await json<{ projects: Project[] }>(
      `${daemon.url}/projects`,
    );
    expect(projects.map((p) => p.id)).toEqual([opened.id]);
    expect(projects[0]?.root).toBe(root);
    // And the daemon comes back up *on* it, rather than making the operator
    // pick again every launch.
    expect(daemon.defaultProject?.project.id).toBe(opened.id);
  });

  it("does not reopen a project whose folder has gone", async () => {
    // `missing` is a listing state, not a thing to boot into. Opening a fresh
    // project on top would be a surprise; the picker says so and the operator
    // decides.
    const root = await projectFolder("gone", "opus");
    const cwd = await realpath(
      await mkdtemp(path.join(tmpdir(), "cuesheet-nocfg2-")),
    );
    daemon = await startDaemon({ port: 0, env, cwd, writeLockFile: false });
    await open(root);
    await daemon.close();
    await rm(root, { recursive: true });

    daemon = await startDaemon({ port: 0, env, cwd, writeLockFile: false });
    expect(daemon.defaultProject).toBeNull();
    const { projects } = await json<{ projects: ListedProject[] }>(
      `${daemon.url}/projects`,
    );
    expect(projects.map((p) => p.status)).toEqual(["missing"]);
  });
});

describe("refusing what it cannot serve", () => {
  beforeEach(async () => {
    daemon = await startDaemon({
      port: 0,
      env,
      cwd: home,
      writeLockFile: false,
    });
  });

  it("turns a traversal attempt into a 400, not a 500 and not a file read", async () => {
    // `projectDir()` throws on a malformed id since Step 31, so the failure
    // mode without this check is a 500 from deep inside the filesystem rather
    // than an answer. Encoded and bare, because a router may decode either.
    for (const attempt of [
      "..%2f..%2fetc",
      "..",
      "API-3f2a1b",
      "not a project id",
    ]) {
      const response = await fetch(
        `${daemon.url}/projects/${attempt}/stations`,
      );
      expect([400, 404]).toContain(response.status);
      expect(response.status).not.toBe(500);
    }
  });

  it("404s a well-formed id the registry has never heard of", async () => {
    const response = await fetch(
      `${daemon.url}/projects/ghost-aaaaaa/stations`,
    );
    expect(response.status).toBe(404);
  });

  it("refuses to open a folder that is not there", async () => {
    const response = await fetch(`${daemon.url}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: path.join(home, "nope") }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /no such folder/i,
    );
  });

  it("forgets a project without touching its folder or its runs", async () => {
    const root = await projectFolder("temporary", "opus");
    const project = await open(root);

    const forgotten = await fetch(`${daemon.url}/projects/${project.id}`, {
      method: "DELETE",
    });
    expect(forgotten.status).toBe(200);
    expect(
      (await json<{ projects: Project[] }>(`${daemon.url}/projects`)).projects,
    ).toEqual([]);

    // Reopening the same folder finds the config still in it. The registry
    // forgets; nothing on disk is destroyed.
    const reopened = await open(root);
    const stations = await json<StationsResponse>(
      `${daemon.url}/projects/${reopened.id}/stations`,
    );
    expect(stations.stations.map((s) => s.station.id)).toEqual(["opus"]);
  });
});
