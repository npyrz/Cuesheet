/**
 * Step 14's done-when: `POST /runs` with the mock cuesheet produces a full run
 * record in under a second.
 *
 * This is the first test that exercises the whole spine at once — HTTP into
 * the queue, into a real harness, through the leashed workspace, out to the
 * bus and the run store — which is exactly why the mock harness was built
 * before the real one. Every assertion here would otherwise need a model, a
 * network, and a few seconds.
 */
import {
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMockHarness,
  createHarnessRegistry,
  type Harness,
} from "@cuesheet/harness";
import type { HostEnv, Run, RunEvent } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";
import { createFileRunStore, type StoredRun } from "./store.js";
import { createRunIdFactory } from "./ids.js";

let env: HostEnv;
let cwd: string;
let root: string;
let workspace: string;
let daemon: DaemonHandle | null = null;

beforeEach(async () => {
  const home = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-hx-")),
  );
  env = { platform: process.platform, homedir: home };
  cwd = path.join(home, "project");
  workspace = path.join(home, "workspace");
  root = path.join(home, "runs");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "cuesheet.toml"),
    `
[[station]]
id = "fake"
harness = "mock"
role = "engineer"
workspace = ${JSON.stringify(workspace)}
paths = ["**"]
deny = [".git/**"]
`,
    "utf8",
  );
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

/** The mock without its scripted standby, so a run completes unattended. */
function quietRuntime() {
  return harnessRuntime({
    registry: createHarnessRegistry([
      { ...createMockHarness({ standby: false }), id: "mock" },
    ]),
  });
}

async function boot(runtime = quietRuntime()): Promise<DaemonHandle> {
  daemon = await startDaemon({
    port: 0,
    env,
    cwd,
    writeLockFile: false,
    store: createFileRunStore({ root, newId: createRunIdFactory() }),
    ...runtime,
  });
  return daemon;
}

async function post(url: string, body?: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

/**
 * The patch, from the route that serves it.
 *
 * `GET /runs/:id` deliberately no longer carries the diff — a run against a
 * workspace with a large untracked tree writes megabytes, and that route is
 * what the Desk calls to open a run row. The bytes live at `/runs/:id/diff`.
 */
async function fetchDiff(url: string, runId: string): Promise<string | null> {
  const response = await fetch(`${url}/runs/${runId}/diff`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`diff fetch failed: ${response.status}`);
  return response.text();
}

async function waitForRun(url: string, runId: string): Promise<StoredRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${url}/runs/${runId}`);
    if (response.ok) {
      const stored = (await response.json()) as StoredRun;
      if (stored.run.finishedAt) return stored;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} never finished`);
}

describe("POST /runs against a real harness", () => {
  it("produces a full run record in under a second", async () => {
    const { url } = await boot();
    const started = Date.now();

    const response = await post(`${url}/runs`, { prompt: "add a greeting" });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };

    const stored = await waitForRun(url, runId);
    expect(Date.now() - started).toBeLessThan(1000);

    expect(stored.run.status).toBe("done");
    expect(stored.run.stationIds).toEqual(["fake"]);
    expect(stored.run.finishedAt).toBeTruthy();
    expect(stored.run.cost.tokensOut).toBeGreaterThan(0);
  });

  it("attributes every event to the run and the Station", async () => {
    // Stamped by the adapter rather than by each harness, so a harness cannot
    // misattribute an event — invisible until two runs are on screen at once.
    const { url } = await boot();
    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "go" })
    ).json()) as { runId: string };
    const stored = await waitForRun(url, runId);

    for (const event of stored.events) {
      expect(event.runId).toBe(runId);
      expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      if ("stationId" in event) expect(event.stationId).toBe("fake");
    }
  });

  it("records the file the harness wrote, and the one the leash refused", async () => {
    const { url } = await boot();
    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "go" })
    ).json()) as { runId: string };
    const stored = await waitForRun(url, runId);

    const kinds = stored.events.map((event) => event.t);
    expect(kinds).toContain("file");
    expect(kinds).toContain("denial");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("done");

    // Enforced, not merely reported: the refused path is outside the
    // workspace and must not exist.
    const escaped = path.join(
      path.dirname(workspace),
      "outside-the-workspace.txt",
    );
    await expect(readFile(escaped, "utf8")).rejects.toThrow();
  });

  it("writes diff.patch when the workspace is a git repo", async () => {
    // Step 16's done-when depends on this path existing; the mock proves the
    // wiring without spending a token.
    const { run: spawnRun } = await import("@cuesheet/harness");
    await spawnRun("git", ["init", "-q", "."], { cwd: workspace });
    await spawnRun("git", ["config", "user.email", "t@example.com"], {
      cwd: workspace,
    });
    await spawnRun("git", ["config", "user.name", "T"], { cwd: workspace });
    await writeFile(path.join(workspace, "src/seed.txt"), "seed\n", "utf8");
    await spawnRun("git", ["add", "-A"], { cwd: workspace });
    await spawnRun("git", ["commit", "-qm", "init"], { cwd: workspace });

    const { url } = await boot();
    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "go" })
    ).json()) as { runId: string };
    const stored = await waitForRun(url, runId);

    expect(await fetchDiff(url, runId)).toContain("cuesheet-mock.md");
    expect(stored.run.result?.diff?.filesChanged).toBeGreaterThan(0);
    // The patch stays on disk; the wire event carries only the stat, because a
    // diff can be megabytes and every client is subscribed.
    expect(JSON.stringify(stored.run.result)).not.toContain("cuesheet-mock.md");
  }, 30_000);

  it("answers a standby over HTTP and completes the run", async () => {
    // The full loop the README describes: the run pauses, the operator taps
    // GO from anywhere that can reach the API, and the run carries on.
    const { url } = await boot(
      harnessRuntime({
        registry: createHarnessRegistry([
          { ...createMockHarness({ standby: true }), id: "mock" },
        ]),
      }),
    );

    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "ask me first" })
    ).json()) as { runId: string };

    const standbyId = await waitForStandby(url, runId);
    expect(
      (await post(`${url}/standbys/${standbyId}`, { answer: "go" })).ok,
    ).toBe(true);

    const stored = await waitForRun(url, runId);
    expect(stored.run.status).toBe("done");
    expect(
      await readFile(path.join(workspace, "cuesheet-mock.md"), "utf8"),
    ).toContain("Mock run");
  }, 15_000);

  it("fails the run, with a reason, when the Station names an unknown harness", async () => {
    // A typo'd harness name names itself. Silently skipping the Station and
    // reporting success is the alternative, and it is much worse.
    await writeFile(
      path.join(cwd, "cuesheet.toml"),
      `
[[station]]
id = "fake"
harness = "not-a-real-harness"
role = "engineer"
workspace = ${JSON.stringify(workspace)}
`,
      "utf8",
    );
    const { url } = await boot();
    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "go" })
    ).json()) as { runId: string };
    const stored = await waitForRun(url, runId);

    expect(stored.run.status).toBe("failed");
    expect(stored.run.error).toMatch(/not-a-real-harness/);
  });

  it("fails readably when there is no Station at all", async () => {
    await writeFile(path.join(cwd, "cuesheet.toml"), "[desk]\n", "utf8");
    const { url } = await boot();
    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "go" })
    ).json()) as { runId: string };
    const stored = await waitForRun(url, runId);

    expect(stored.run.status).toBe("failed");
    expect(stored.run.error).toMatch(/no Station/i);
  });
});

describe("GET /stations with a real prober", () => {
  it("reports the mock as installed", async () => {
    // The mock ships rather than being a test fixture: someone with no agent
    // CLI installed can still open the app and watch the Desk work.
    const { url } = await boot();
    const body = (await (await fetch(`${url}/stations`)).json()) as {
      stations: Array<{ probe: { installed: boolean; harness: string } }>;
    };
    expect(body.stations[0]?.probe).toMatchObject({
      harness: "mock",
      installed: true,
    });
  });
});

describe("stopping a run mid-flight", () => {
  it("keeps the diff of the work done before the stop", async () => {
    // The two shipped harnesses disagree about abort: `claude-code` returns
    // `{ status: "stopped" }` while the mock *throws* an AbortError. A run
    // whose harness threw must still record what it wrote — a stopped run's
    // partial diff is exactly what the operator wants to look at.
    const { run: spawnRun } = await import("@cuesheet/harness");
    await spawnRun("git", ["init", "-q", "."], { cwd: workspace });
    await spawnRun("git", ["config", "user.email", "t@example.com"], {
      cwd: workspace,
    });
    await spawnRun("git", ["config", "user.name", "T"], { cwd: workspace });
    await writeFile(path.join(workspace, "src/seed.txt"), "seed\n", "utf8");
    await spawnRun("git", ["add", "-A"], { cwd: workspace });
    await spawnRun("git", ["commit", "-qm", "init"], { cwd: workspace });

    // Writes first, then blocks until aborted and rejects — the throwing path.
    const writeThenHang: Harness = {
      ...createMockHarness({ standby: false }),
      id: "mock",
      async run(ctx) {
        await ctx.workspace.write("partial-work.txt", "half a thought\n");
        await new Promise<never>((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () => {
            const error = new Error("The run was stopped.");
            error.name = "AbortError";
            reject(error);
          });
        });
        return {};
      },
    };

    const { url } = await boot(
      harnessRuntime({ registry: createHarnessRegistry([writeThenHang]) }),
    );

    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "start something" })
    ).json()) as { runId: string };

    await waitForStatus(url, runId, "running");
    // Wait for the write to actually land, so the diff is not empty by timing.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(path.join(workspace, "partial-work.txt"), "utf8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await post(`${url}/runs/${runId}/stop`);

    const stored = await waitForRun(url, runId);
    expect(stored.run.status).toBe("stopped");
    expect(await fetchDiff(url, runId)).toContain("partial-work.txt");
  }, 30_000);

  it("lands as stopped, not running", async () => {
    // Step 23's invariant, one phase early: a run must always reach a terminal
    // status. `stepMs` makes the mock slow enough to catch in the act.
    const { url } = await boot(
      harnessRuntime({
        registry: createHarnessRegistry([
          {
            ...createMockHarness({ standby: false, stepMs: 200 }),
            id: "mock",
          },
        ]),
      }),
    );
    const { runId } = (await (
      await post(`${url}/runs`, { prompt: "take your time" })
    ).json()) as { runId: string };

    await waitForStatus(url, runId, "running");
    await post(`${url}/runs/${runId}/stop`);

    const stored = await waitForRun(url, runId);
    expect(stored.run.status).toBe("stopped");
  }, 20_000);
});

async function waitForStandby(url: string, runId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${url}/runs/${runId}`);
    if (response.ok) {
      const { events } = (await response.json()) as { events: RunEvent[] };
      const standby = events.find(
        (event): event is Extract<RunEvent, { t: "standby" }> =>
          event.t === "standby",
      );
      if (standby) return standby.standbyId;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No standby was raised");
}

async function waitForStatus(
  url: string,
  runId: string,
  status: Run["status"],
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${url}/runs/${runId}`);
    if (response.ok) {
      const stored = (await response.json()) as StoredRun;
      if (stored.run.status === status) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} never reached ${status}`);
}
