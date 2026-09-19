import { mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type {
  HostEnv,
  Run,
  RunEvent,
  Standby,
  Station,
  UsageWindow,
} from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import {
  createFileRunStore,
  type RunDetailResponse,
  type StoredRun,
} from "./store.js";
import { createRunIdFactory } from "./ids.js";
import type { RunExecutor } from "./executor.js";
import type { StopOutcome } from "./queue.js";
import type { StationsResponse } from "./stations.js";

const CONFIG = `
[desk]
name = "Test Desk"

[[station]]
id = "opus"
harness = "claude-code"
role = "engineer"
model = "opus"
workspace = "/tmp/ws"
paths = ["src/**"]
deny = [".git/**"]

[[station]]
id = "sonnet"
harness = "claude-code"
role = "reviewer"
workspace = "/tmp/ws"

[cuesheet.ship]
cues = [
  { station = "opus", action = "implement" },
  { gate = "default" },
  { station = "sonnet", action = "review" },
]

[gate.default]
require = "1-of-1"

[limits]
warn_at = 0.85

[remote]
tailnet = true
`;

let env: HostEnv;
let cwd: string;
let root: string;
let daemon: DaemonHandle;

async function boot(executor?: RunExecutor): Promise<DaemonHandle> {
  // `port: 0` binds an ephemeral port, so these files can run in parallel
  // vitest workers without fighting each other or a dev daemon on 7373.
  daemon = await startDaemon({
    port: 0,
    env,
    cwd,
    writeLockFile: false,
    store: createFileRunStore({ root, newId: createRunIdFactory() }),
    ...(executor && { executor }),
  });
  return daemon;
}

const done: RunExecutor = () =>
  Promise.resolve({
    status: "done" as const,
    cost: { tokensIn: 0, tokensOut: 0 },
    durationMs: 0,
  });

/**
 * Waits for a condition instead of guessing how long it takes to arrive.
 *
 * Every wait in this file is on the far side of an HTTP round trip *and* a
 * queue turn *and* an executor reaching its first await, and a runner under
 * load does not do all three inside a fixed 20ms. It went red on CI exactly
 * once before this existed. `queue.test.ts` carries the same helper for the
 * same reason; a timeout here fails with what it was waiting for rather than
 * with `expected undefined to be …`.
 */
async function waitFor(
  what: string,
  ready: () => boolean,
  timeoutMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

const runIsActive = (runId: string) => () =>
  defaultRuntime().queue.activeRunId() === runId;

/**
 * The project the daemon bootstrapped from `cwd`'s `cuesheet.toml`.
 *
 * Every test in this file has exactly one project, so "the project" is
 * unambiguous here in a way it deliberately is not in the HTTP API — the
 * daemon has no active-project concept, and a client says which one it means.
 */
function defaultRuntime(): NonNullable<DaemonHandle["defaultProject"]> {
  const runtime = daemon.defaultProject;
  if (!runtime) throw new Error("the daemon bootstrapped no project");
  return runtime;
}

/** Where every project-scoped route hangs off. */
function projectBase(): string {
  return `${daemon.url}/projects/${defaultRuntime().project.id}`;
}

async function bootProject(executor?: RunExecutor): Promise<string> {
  await boot(executor);
  return projectBase();
}

/**
 * The same project, under the `/api` prefix the Vite dev server proxies.
 *
 * The prefix goes *ahead* of the project segment — `/api/projects/:id/...` —
 * because the whole route tree is registered twice, once bare and once scoped.
 */
function apiProjectBase(): string {
  return `${daemon.url}/api/projects/${defaultRuntime().project.id}`;
}

beforeEach(async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cuesheet-home-"));
  env = { platform: process.platform, homedir: home };
  // `realpath` because the project registry resolves a root before storing it
  // — on macOS `/var` is a symlink to `/private/var`, so without this every
  // `sourcePath` assertion below compares two spellings of the same file.
  cwd = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-cwd-")));
  root = await mkdtemp(path.join(tmpdir(), "cuesheet-runs-"));
  await writeFile(path.join(cwd, "cuesheet.toml"), CONFIG, "utf8");
});

afterEach(async () => {
  await daemon?.close();
});

/**
 * Typed against the real exported response shapes rather than `any`, so these
 * smoke tests also fail to compile if a route's contract changes underneath
 * them — the Desk and the phone are the other consumers of exactly these types.
 */
interface Response_<T> {
  status: number;
  body: T;
}

async function get<T = unknown>(url: string, p: string): Promise<Response_<T>> {
  const response = await fetch(`${url}${p}`);
  return { status: response.status, body: (await response.json()) as T };
}

async function post<T = unknown>(
  url: string,
  p: string,
  body?: unknown,
): Promise<Response_<T>> {
  const response = await fetch(`${url}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

interface Health {
  ok: true;
  version: string;
}
interface Enqueued {
  runId: string;
}
interface RunList {
  runs: Run[];
}
interface Stopped {
  runId: string;
  outcome: StopOutcome;
}
interface Answered {
  standby: Standby;
}
interface ApiError {
  error: string;
}

describe("GET /usage", () => {
  it("answers with a row for every harness, and nothing by default", async () => {
    // `startDaemon` is a library and its default is "no harnesses wired", the
    // same default that makes `unprobed` the default prober. A test suite that
    // shelled out to whatever is installed on the machine is not a test suite.
    await boot();
    const { status, body } = await get<{ harnesses: unknown[] }>(
      daemon.url,
      "/usage",
    );
    expect(status).toBe(200);
    expect(body.harnesses).toEqual([]);
  });

  it("is global, because a plan window is not a property of a repository", async () => {
    // Step 38 renders this strip inside a project, which makes the route look
    // like it should have been `/projects/:id/usage`. It is the same five-hour
    // window whichever repository you are standing in, and serving a copy per
    // project invites a client to add four of them up.
    //
    // Both halves are asserted here rather than in two tests. A 404 under
    // `/projects/:id` alone would also pass if the route did not exist at all,
    // or if this file had the path wrong — it would prove the name of the
    // failure, not the shape of the API.
    const base = await bootProject();
    expect((await get(daemon.url, "/usage")).status).toBe(200);
    expect((await get(base, "/usage")).status).toBe(404);
  });

  it("serves what the wired harnesses report", async () => {
    daemon = await startDaemon({
      port: 0,
      env,
      cwd,
      writeLockFile: false,
      store: createFileRunStore({ root, newId: createRunIdFactory() }),
      usageSources: () => [
        {
          id: "local",
          vendor: "ollama",
          usage: async () => [{ window: "local", state: "unmetered" as const }],
        },
      ],
    });

    const { body } = await get<{
      harnesses: { harness: string; vendor: string; windows: unknown[] }[];
    }>(daemon.url, "/usage");
    expect(body.harnesses).toEqual([
      {
        harness: "local",
        vendor: "ollama",
        windows: [{ window: "local", state: "unmetered" }],
      },
    ]);
  });
});

describe("usage after a run", () => {
  it("re-reads once a run finishes, rather than serving a pre-run window", async () => {
    // A finished run is the one moment plan usage moves: `claude-code` learns
    // its limits only from inside a run. Without the invalidation the strip
    // would show the window from *before* the run that spent it, for up to the
    // cache's whole TTL — the stalest answer this cache can give, at exactly
    // the moment somebody looks.
    let reads = 0;
    daemon = await startDaemon({
      port: 0,
      env,
      cwd,
      writeLockFile: false,
      store: createFileRunStore({ root, newId: createRunIdFactory() }),
      executor: done,
      usageSources: () => [
        {
          id: "claude-code",
          vendor: "anthropic",
          usage: async () => {
            reads += 1;
            return [{ window: "5h", state: "not-blocked" as const }];
          },
        },
      ],
    });

    await get(daemon.url, "/usage");
    // Cached: a second look inside the TTL must not re-read.
    await get(daemon.url, "/usage");
    expect(reads).toBe(1);

    const started = await post<{ runId: string }>(projectBase(), "/runs", {
      prompt: "spend some tokens",
    });
    // Polled rather than slept on: a queue turn plus two HTTP round trips does
    // not reliably fit inside any fixed delay a loaded runner would honour.
    let finished = false;
    for (let attempt = 0; attempt < 200 && !finished; attempt += 1) {
      const run = await get<{ run: { finishedAt?: string } }>(
        projectBase(),
        `/runs/${started.body.runId}`,
      );
      finished = run.body.run.finishedAt !== undefined;
      if (!finished) await new Promise((r) => setTimeout(r, 10));
    }
    expect(finished).toBe(true);

    await get(daemon.url, "/usage");
    expect(reads).toBe(2);
  });
});

describe("the pre-run check", () => {
  /** A daemon whose one wired harness reports whatever this test needs. */
  async function bootWithUsage(windows: UsageWindow[]): Promise<string> {
    daemon = await startDaemon({
      port: 0,
      env,
      cwd,
      writeLockFile: false,
      store: createFileRunStore({ root, newId: createRunIdFactory() }),
      executor: done,
      usageSources: () => [
        { id: "claude-code", vendor: "anthropic", usage: async () => windows },
      ],
    });
    return projectBase();
  }

  it("refuses a run that cannot finish, with the window that stopped it", async () => {
    // The README's complaint, answered: no vendor tells you where you stand
    // until you hit the wall, "usually eleven minutes into something that
    // mattered". This is the refusal at second zero instead.
    const url = await bootWithUsage([
      { window: "five_hour", state: "measured", used: 1 },
    ]);
    const { status, body } = await post<{
      error: string;
      limits: { vendor: string; window: string }[];
    }>(url, "/runs", { prompt: "something that mattered" });

    expect(status).toBe(409);
    expect(body.error).toContain("would not finish");
    // The windows, not just a sentence — the Desk has to name the vendor.
    expect(body.limits[0]).toMatchObject({
      vendor: "anthropic",
      window: "five_hour",
    });

    // And nothing was queued. A refusal that still enqueues is a run that dies
    // halfway, which is the thing being prevented.
    const { body: listed } = await get<{ runs: Run[] }>(url, "/runs");
    expect(listed.runs).toEqual([]);
  });

  it("starts a warned run, and hands back what it was warned about", async () => {
    const url = await bootWithUsage([
      { window: "weekly", state: "measured", used: 0.9 },
    ]);
    const { status, body } = await post<{
      runId: string;
      limits?: { used: number }[];
    }>(url, "/runs", { prompt: "carry on" });

    expect(status).toBe(202);
    expect(body.runId).toBeTruthy();
    expect(body.limits?.[0]?.used).toBe(0.9);
  });

  it("never refuses on an answer nobody measured", async () => {
    // The three states that are not measurements. Refusing on any of them
    // would be inventing a number — the strip's failure mode, aimed at the
    // operator's ability to work instead of at their bill.
    for (const window of [
      { window: "5h", state: "not-blocked" as const },
      { window: "plan", state: "unknown" as const },
      { window: "local", state: "unmetered" as const },
    ]) {
      await daemon?.close();
      const url = await bootWithUsage([window]);
      const { status } = await post(url, "/runs", { prompt: "go" });
      expect(status).toBe(202);
    }
  });

  it("ignores a capped harness this run would never reach", async () => {
    // The config's only Station is on `claude-code`. A capped Codex in the
    // same daemon must not stop it.
    daemon = await startDaemon({
      port: 0,
      env,
      cwd,
      writeLockFile: false,
      store: createFileRunStore({ root, newId: createRunIdFactory() }),
      executor: done,
      usageSources: () => [
        {
          id: "codex",
          vendor: "openai",
          usage: async () => [
            { window: "plan", state: "measured" as const, used: 1 },
          ],
        },
      ],
    });
    const { status } = await post(projectBase(), "/runs", { prompt: "go" });
    expect(status).toBe(202);
  });
});

describe("GET /health", () => {
  it("returns ok and a version", async () => {
    // Step 8's done-when, against a real listening server. Global on purpose:
    // `/health` is about the process, not about any project.
    await boot();
    const { status, body } = await get<Health>(daemon.url, "/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, version: expect.any(String) });
  });

  it("reports the port it actually bound", async () => {
    const handle = await boot();
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
  });

  it("is also served under /api, for the Vite dev proxy", async () => {
    await boot();
    // Step 17's dev server proxies `/api` and `/ws`. Serving both prefixes
    // beats a rewrite rule and keeps `curl :7373/health` working.
    expect((await get<Health>(daemon.url, "/api/health")).body).toEqual({
      ok: true,
      version: expect.any(String),
    });
  });
});

describe("GET /stations", () => {
  it("returns configured stations with probe results", async () => {
    const url = await bootProject();
    const { status, body } = await get<StationsResponse>(url, "/stations");
    expect(status).toBe(200);

    const stations = body.stations as Array<{
      station: { id: string };
      probe: unknown;
    }>;
    expect(stations.map((s) => s.station.id)).toEqual(["opus", "sonnet"]);
    expect(stations[0]?.probe).toMatchObject({
      harness: "claude-code",
      installed: false,
    });
  });

  it("surfaces the loader's warnings for unimplemented tables", async () => {
    // Step 6 collects these precisely so this route can report them; without
    // it a user never learns which of their tables are parsed but not live.
    //
    // The table under test has now moved twice, which is the point: this
    // asserted on `[gate]` until Gates shipped and on `[limits]` until Step 38,
    // and `[remote]` is what is still deferred today. A warning that outlives
    // the thing it warns about is worse than none.
    const url = await bootProject();
    const { body } = await get<StationsResponse>(url, "/stations");
    const warnings = body.warnings as Array<{
      table?: string;
      message: string;
    }>;
    expect(warnings.some((w) => w.table === "remote")).toBe(true);
    expect(warnings.some((w) => w.message.includes("Phone pairing"))).toBe(
      true,
    );
    // Neither of the two that have since shipped warns any more.
    expect(warnings.some((w) => w.table === "gate")).toBe(false);
    expect(warnings.some((w) => w.table === "limits")).toBe(false);
  });

  it("reports which file the config came from", async () => {
    const url = await bootProject();
    const { body } = await get<StationsResponse>(url, "/stations");
    expect(body.sourcePath).toBe(path.join(cwd, "cuesheet.toml"));
  });

  it("lists every known harness, installed first", async () => {
    const url = await bootProject();
    const { body } = await get<StationsResponse>(url, "/stations");
    const harnesses = body.harnesses as Array<{ harness: string }>;
    // Step 20's panel renders installed harnesses first and greys out the rest.
    expect(harnesses.map((h) => h.harness)).toContain("codex");
    expect(harnesses.map((h) => h.harness)).toContain("ollama");
  });

  it("bootstraps no project at all when there is no config anywhere", async () => {
    // Step 32's done-when: `GET /projects` answers before any project has been
    // opened. It used to be `/stations` answering with an empty list — but a
    // fresh install has no project to have Stations *of*, and inventing one
    // would put a folder in the picker that nobody chose.
    const empty = await mkdtemp(path.join(tmpdir(), "cuesheet-empty-"));
    daemon = await startDaemon({
      port: 0,
      env,
      cwd: empty,
      writeLockFile: false,
    });
    expect(daemon.defaultProject).toBeNull();
    const { status, body } = await get<{ projects: unknown[] }>(
      daemon.url,
      "/projects",
    );
    expect(status).toBe(200);
    expect(body.projects).toEqual([]);
  });

  it("says a folder is not there rather than failing obscurely", async () => {
    // Step 40's second clause. The launch surface disables a `missing` recent
    // so this should be hard to reach — but "hard to reach" is not "cannot
    // happen": a folder can go away between the list being drawn and the row
    // being clicked, and a typed path reaches here directly.
    await boot();
    const gone = path.join(cwd, "not-a-folder-anybody-made");
    const { status, body } = await post<ApiError>(daemon.url, "/projects", {
      root: gone,
    });
    expect(status).toBe(400);
    // The registry's own message, which names the path. A generic failure
    // would leave somebody re-typing a path that was never mistyped.
    expect(body.error).toContain(gone);
  });

  it("forgets a project without touching its folder", async () => {
    // What makes a `missing` recent dismissable rather than a permanent dead
    // end in the launch list.
    const base = await bootProject();
    const id = base.slice(base.lastIndexOf("/") + 1);

    const before = await get<{ projects: unknown[] }>(daemon.url, "/projects");
    expect(before.body.projects).toHaveLength(1);

    const removed = await fetch(`${daemon.url}/projects/${id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);

    const after = await get<{ projects: unknown[] }>(daemon.url, "/projects");
    expect(after.body.projects).toEqual([]);
    // The directory is still there. Forgetting is a registry operation and has
    // never been a delete.
    expect((await stat(cwd)).isDirectory()).toBe(true);
  });
});

describe("POST /runs", () => {
  it("enqueues a run and returns its id", async () => {
    const url = await bootProject(done);
    const { status, body } = await post<Enqueued>(url, "/runs", {
      prompt: "ship it",
    });
    expect(status).toBe(202);
    expect(body.runId).toMatch(/^\d{8}T\d{9}Z-\d{4}$/);
  });

  it("resolves the workspace and station from config", async () => {
    const url = await bootProject(done);
    const { body } = await post<Enqueued>(url, "/runs", { prompt: "ship it" });
    await defaultRuntime().queue.idle();

    const { body: stored } = await get<StoredRun>(url, `/runs/${body.runId}`);
    expect(stored.run.workspace).toBe("/tmp/ws");
    expect(stored.run.stationIds).toEqual(["opus"]);
  });

  it("expands a named cuesheet into its stations, skipping gate refs", async () => {
    const url = await bootProject(done);
    const { body } = await post<Enqueued>(url, "/runs", {
      prompt: "ship it",
      cuesheet: "ship",
    });
    await defaultRuntime().queue.idle();

    const { body: stored } = await get<StoredRun>(url, `/runs/${body.runId}`);
    // `{ gate = "default" }` is a cue kind, not a Station: it does not appear
    // in `stationIds`, which is the list of Stations the run touches. The
    // executor plans gates from the cuesheet itself.
    expect(stored.run.stationIds).toEqual(["opus", "sonnet"]);
    expect(stored.run.cuesheetId).toBe("ship");
  });

  it("rejects a missing or empty prompt", async () => {
    const url = await bootProject();
    expect((await post(url, "/runs", {})).status).toBe(400);
    expect((await post(url, "/runs", { prompt: "   " })).status).toBe(400);
    expect((await post(url, "/runs", { prompt: 42 })).status).toBe(400);
  });

  it("404s for an unknown cuesheet", async () => {
    const url = await bootProject();
    const { status } = await post(url, "/runs", {
      prompt: "hi",
      cuesheet: "nope",
    });
    expect(status).toBe(404);
  });
});

describe("GET /runs", () => {
  it("lists runs newest first", async () => {
    const url = await bootProject(done);
    const first = await post<Enqueued>(url, "/runs", { prompt: "one" });
    const second = await post<Enqueued>(url, "/runs", { prompt: "two" });
    await defaultRuntime().queue.idle();

    const { body } = await get<RunList>(url, "/runs");
    const runs = body.runs as Array<{ id: string; prompt: string }>;
    expect(runs.map((r) => r.id)).toEqual([
      second.body.runId,
      first.body.runId,
    ]);
    expect(runs[0]?.prompt).toBe("two");
  });

  it("is an empty list before anything has run", async () => {
    const url = await bootProject();
    expect((await get<RunList>(url, "/runs")).body.runs).toEqual([]);
  });

  it("honours ?limit=", async () => {
    const url = await bootProject(done);
    await post(url, "/runs", { prompt: "one" });
    await post(url, "/runs", { prompt: "two" });
    await defaultRuntime().queue.idle();
    expect((await get<RunList>(url, "/runs?limit=1")).body.runs).toHaveLength(
      1,
    );
  });
});

describe("GET /runs/:id", () => {
  it("returns the run plus its events", async () => {
    const url = await bootProject(async (ctx) => {
      ctx.emit({
        t: "text",
        at: new Date().toISOString(),
        runId: ctx.run.id,
        stationId: "opus",
        chunk: "working",
      });
      return done(ctx);
    });

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "ship it" });
    await defaultRuntime().queue.idle();

    const { status, body: stored } = await get<RunDetailResponse>(
      url,
      `/runs/${body.runId}`,
    );
    expect(status).toBe(200);
    expect(stored.run.status).toBe("done");
    const events = stored.events as RunEvent[];
    expect(events.some((e) => e.t === "text")).toBe(true);
    expect(events.some((e) => e.t === "done")).toBe(true);
  });

  it("404s for a well-formed id that does not exist", async () => {
    const url = await bootProject();
    expect((await get(url, "/runs/20260910T142233104Z-9999")).status).toBe(404);
  });

  it("400s a malformed id instead of letting it reach the filesystem", async () => {
    // A run id is a directory name, so an unvalidated param is a traversal.
    // Percent-encoded separators are the ones that matter: they survive the
    // client's URL normalization and arrive at the handler decoded.
    const url = await bootProject();
    for (const hostile of [
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "..%2f..%2fetc%2fpasswd",
      "not-an-id",
      "20260910T142233104Z",
      "20260910T142233104Z-1",
    ]) {
      const { status, body } = await get<ApiError>(url, `/runs/${hostile}`);
      expect(status, hostile).toBe(400);
      expect(body).toEqual({ error: "Malformed run id." });
    }
  });
});

describe("POST /runs/:id/stop", () => {
  it("stops a running run", async () => {
    const url = await bootProject(
      (ctx) =>
        new Promise((_resolve, reject) => {
          const abort = () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          // The shape `spawn.ts` uses: an already-aborted signal fires no
          // event, so a listener alone would wait forever.
          if (ctx.signal.aborted) abort();
          else ctx.signal.addEventListener("abort", abort, { once: true });
        }),
    );

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "long one" });
    await waitFor("the run to start", runIsActive(body.runId));

    const stopped = await post<Stopped>(url, `/runs/${body.runId}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.outcome).toBe("stopped-running");

    await defaultRuntime().queue.idle();
    const { body: stored } = await get<StoredRun>(url, `/runs/${body.runId}`);
    expect(stored.run.status).toBe("stopped");
  });

  it("404s an unknown run and 400s a malformed id", async () => {
    const url = await bootProject();
    expect(
      (await post(url, "/runs/20260910T142233104Z-9999/stop")).status,
    ).toBe(404);
    expect((await post(url, "/runs/nope/stop")).status).toBe(400);
  });
});

describe("POST /standbys/:id", () => {
  it("answers a waiting standby and resumes the run", async () => {
    let answer: string | undefined;
    const url = await bootProject(async (ctx) => {
      answer = await ctx.ask({ ask: "Write to infra/?", kind: "permission" });
      return done(ctx);
    });

    await post(url, "/runs", { prompt: "ship it" });
    await waitFor(
      "the standby to be raised",
      () => daemon.standbys.list().length > 0,
    );

    const [pending] = daemon.standbys.list();
    expect(pending?.ask).toBe("Write to infra/?");

    const { status, body } = await post<Answered>(
      daemon.url,
      `/standbys/${pending!.id}`,
      { answer: "go" },
    );
    expect(status).toBe(200);
    expect(body.standby.answer).toBe("go");

    await defaultRuntime().queue.idle();
    expect(answer).toBe("go");
  });

  it("rejects an answer that is not go or no", async () => {
    await boot();
    expect(
      (await post(daemon.url, "/standbys/sb_1", { answer: "maybe" })).status,
    ).toBe(400);
    expect((await post(daemon.url, "/standbys/sb_1", {})).status).toBe(400);
  });

  it("404s when nothing is waiting on that id", async () => {
    await boot();
    expect(
      (await post(daemon.url, "/standbys/sb_nope", { answer: "go" })).status,
    ).toBe(404);
  });
});

describe("GET /ws", () => {
  /**
   * Open a socket, collecting messages from the moment it is constructed.
   *
   * The handler is attached synchronously, before `open` is awaited, for the
   * same reason `bus.attach` returns its backlog in one call: the server
   * writes the replay backlog the instant the upgrade completes, so a listener
   * attached after `await open` can miss frames that already arrived. A test
   * that awaits first passes or fails on loopback timing.
   */
  function listen(url: string) {
    const socket = new WebSocket(`${url.replace("http", "ws")}/ws`);
    const events: RunEvent[] = [];
    let notify: (() => void) | null = null;

    socket.on("message", (data) => {
      events.push(JSON.parse(String(data)) as RunEvent);
      notify?.();
    });

    const opened = new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    function until(
      predicate: (events: RunEvent[]) => boolean,
      timeoutMs = 3000,
    ): Promise<RunEvent[]> {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!predicate(events)) return;
          clearTimeout(timer);
          notify = null;
          resolve(events);
        };
        const timer = setTimeout(() => {
          notify = null;
          reject(new Error(`timed out with ${events.length} events`));
        }, timeoutMs);
        notify = check;
        check();
      });
    }

    return { socket, events, opened, until };
  }

  it("streams events as JSON lines", async () => {
    // Step 9's done-when, with a real client over a real upgrade.
    const url = await bootProject(done);
    const client = listen(url);
    await client.opened;
    try {
      await post(url, "/runs", { prompt: "ship it" });
      const events = await client.until((e) => e.some((x) => x.t === "done"));

      expect(events.map((e) => e.t)).toContain("status");
      expect(events.map((e) => e.t)).toContain("done");
      expect(
        events.every(
          (e) => typeof e.runId === "string" && typeof e.at === "string",
        ),
      ).toBe(true);
    } finally {
      client.socket.close();
    }
  });

  it("replays a mid-run backlog to a client that connects late", async () => {
    let release!: () => void;
    let emitted = false;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const url = await bootProject(async (ctx) => {
      ctx.emit({
        t: "text",
        at: new Date().toISOString(),
        runId: ctx.run.id,
        stationId: "opus",
        chunk: "already happened",
      });
      emitted = true;
      await gate;
      return done(ctx);
    });

    await post(url, "/runs", { prompt: "ship it" });
    // Not a sleep: the point of this test is that the event is already in the
    // backlog *before* the client attaches. Connecting too early would take
    // the live path instead and the test would quietly stop covering replay —
    // still green, and no longer testing anything.
    await waitFor("the event to be emitted before we attach", () => emitted);

    // Connecting mid-run must not leave the client staring at nothing.
    const client = listen(url);
    await client.opened;
    try {
      const backlogged = await client.until((e) =>
        e.some((x) => x.t === "text" && x.chunk === "already happened"),
      );
      expect(backlogged.some((e) => e.t === "status")).toBe(true);

      release();
      const events = await client.until((e) => e.some((x) => x.t === "done"));
      // No duplicate of the replayed event once the live stream takes over.
      expect(
        events.filter((e) => e.t === "text" && e.chunk === "already happened"),
      ).toHaveLength(1);
    } finally {
      client.socket.close();
    }
  });

  it("drops its subscription when the client disconnects", async () => {
    await boot();
    const url = projectBase();
    const baseline = defaultRuntime().bus.subscriberCount();
    const client = listen(url);
    await client.opened;
    // Compared against a baseline rather than zero: every project's bus
    // carries one permanent subscriber of its own — the mirror that forwards
    // into the daemon-wide bus for the tray. Asserting `=== 0` would be
    // asserting that the mirror had gone too.
    expect(defaultRuntime().bus.subscriberCount()).toBeGreaterThan(baseline);

    client.socket.close();
    // A leaked subscriber per reconnect is how a long session dies.
    await waitFor(
      "the server to drop the subscription",
      () => defaultRuntime().bus.subscriberCount() === baseline,
    );
    expect(defaultRuntime().bus.subscriberCount()).toBe(baseline);
  });

  it("is also reachable under the /api prefix", async () => {
    await boot(done);
    const socket = new WebSocket(
      `${daemon.url.replace("http", "ws")}/api/projects/${defaultRuntime().project.id}/ws`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
    }
  });
});

describe("close", () => {
  it("stops serving and is idempotent", async () => {
    const handle = await boot();
    await handle.close();
    await expect(handle.close()).resolves.toBeUndefined();
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
  });

  it("closes with a WebSocket client still connected", async () => {
    // Every other test closes its socket first, so shutdown with a live
    // connection is otherwise unexercised — and if it ever blocks, the symptom
    // is a hung CI job with no failing assertion. Step 21 puts this exact
    // `close()` in Electron's `before-quit`, so it has to hold.
    const handle = await boot();
    const socket = new WebSocket(`${projectBase().replace("http", "ws")}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    await expect(handle.close()).resolves.toBeUndefined();
    await expect(fetch(`${handle.url}/health`)).rejects.toThrow();
    socket.close();
  }, 10_000);

  it("marks a run interrupted when the daemon closes under it", async () => {
    const url = await bootProject(
      (ctx) =>
        new Promise((_resolve, reject) => {
          const abort = () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          // The shape `spawn.ts` uses: an already-aborted signal fires no
          // event, so a listener alone would wait forever.
          if (ctx.signal.aborted) abort();
          else ctx.signal.addEventListener("abort", abort, { once: true });
        }),
    );

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "long one" });
    await waitFor("the run to start", runIsActive(body.runId));

    // A run caught by a shutdown must land somewhere terminal and readable,
    // never sit `running` forever.
    await daemon.close();

    const stored = await defaultRuntime().store.get(body.runId);
    expect(stored?.run.status).toBe("interrupted");
    expect(stored?.run.finishedAt).toBeTypeOf("string");
    expect(stored?.events.length).toBeGreaterThan(0);
  }, 10_000);
});

describe("GET /runs/:id/diff", () => {
  /**
   * Records a patch and finishes.
   *
   * `recordDiff` takes only the patch — the `DiffStat` rides on the returned
   * summary, which is what the `done` event carries. That split is the point:
   * the stat goes on the wire, the megabytes go to disk.
   */
  const withDiff = (patch: string): RunExecutor => {
    return async (ctx) => {
      ctx.recordDiff(patch);
      return {
        ...(await done(ctx)),
        diff: { filesChanged: 1, insertions: 2, deletions: 0 },
      };
    };
  };

  it("serves the patch as text", async () => {
    const patch = "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,2 @@\n+added\n";
    const url = await bootProject(withDiff(patch));

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "edit" });
    await defaultRuntime().queue.idle();

    const response = await fetch(`${url}/runs/${body.runId}/diff`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(patch);
  });

  it("keeps the patch out of GET /runs/:id, flagging it instead", async () => {
    // A workspace with a large untracked tree yields a multi-megabyte patch,
    // and this is the route the Desk calls to open a run row.
    const url = await bootProject(withDiff("--- a/x\n+++ b/x\n"));

    const { body } = await post<Enqueued>(url, "/runs", { prompt: "edit" });
    await defaultRuntime().queue.idle();

    const { body: stored } = await get<RunDetailResponse & { diff?: string }>(
      url,
      `/runs/${body.runId}`,
    );
    expect(stored.hasDiff).toBe(true);
    expect(stored.diff).toBeUndefined();
  });

  it("404s when the run wrote no patch", async () => {
    const url = await bootProject(done);
    const { body } = await post<Enqueued>(url, "/runs", { prompt: "nothing" });
    await defaultRuntime().queue.idle();

    const { status } = await get(url, `/runs/${body.runId}/diff`);
    expect(status).toBe(404);

    const { body: stored } = await get<RunDetailResponse & { diff?: string }>(
      url,
      `/runs/${body.runId}`,
    );
    expect(stored.hasDiff).toBe(false);
  });

  it("400s a malformed id rather than reading an arbitrary path", async () => {
    const url = await bootProject();
    const { status } = await get(url, "/runs/..%2f..%2fetc/diff");
    expect(status).toBe(400);
  });
});

describe("POST /stations", () => {
  interface Added {
    station: Station;
    sourcePath: string;
    created: boolean;
    stations: StationsResponse;
  }

  /** A real directory, because the route stats the workspace it is given. */
  async function workspace(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), "cuesheet-ws-"));
  }

  it("writes a [[station]] block to the loaded config and returns a new tile", async () => {
    // Step 20's done-when.
    const url = await bootProject();
    const ws = await workspace();

    const { status, body } = await post<Added>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: ws,
    });

    expect(status).toBe(201);
    expect(body.sourcePath).toBe(path.join(cwd, "cuesheet.toml"));
    expect(body.created).toBe(false);

    const text = await readFile(path.join(cwd, "cuesheet.toml"), "utf8");
    expect(text).toContain('id = "qwen"');
    expect(body.stations.stations.map((s) => s.station.id)).toEqual([
      "opus",
      "sonnet",
      "qwen",
    ]);
  });

  it("leaves the running daemon agreeing with the file it just wrote", async () => {
    const url = await bootProject();
    await post(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });

    // No reload call from the test: the route must have done it, or the tile
    // appears and the next run cannot resolve the Station.
    const { body } = await get<StationsResponse>(url, "/stations");
    expect(body.stations.map((s) => s.station.id)).toContain("qwen");
  });

  it("seeds the leash with .git/** so an allow of ** cannot reach hooks", async () => {
    const url = await bootProject();
    const { body } = await post<Added>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    expect(body.station.paths).toEqual(["**"]);
    expect(body.station.deny).toContain(".git/**");
  });

  it("preserves the tables the test config carries, gates included", async () => {
    // The writer appends to the file's *text*, so nothing it did not write is
    // at risk — whether or not this build parses it. Both cases are checked:
    // `[limits]` is implemented now, `[remote]` is still deferred.
    const url = await bootProject();
    await post(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    const text = await readFile(path.join(cwd, "cuesheet.toml"), "utf8");
    expect(text).toContain("[gate.default]");
    expect(text).toContain('require = "1-of-1"');
    expect(text).toContain("[limits]");
    expect(text).toContain("warn_at = 0.85");
    expect(text).toContain("[remote]");
  });

  it("409s a duplicate id instead of silently shadowing a tile", async () => {
    const url = await bootProject();
    const { status } = await post<ApiError>(url, "/stations", {
      id: "opus",
      harness: "claude-code",
      role: "engineer",
      workspace: await workspace(),
    });
    expect(status).toBe(409);
  });

  it("400s a workspace that does not exist", async () => {
    const url = await bootProject();
    const { status, body } = await post<ApiError>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: path.join(tmpdir(), "cuesheet-definitely-not-here"),
    });
    expect(status).toBe(400);
    expect(body.error).toContain("does not exist");
  });

  it("400s a workspace that is a file", async () => {
    const url = await bootProject();
    const file = path.join(cwd, "cuesheet.toml");
    const { status, body } = await post<ApiError>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: file,
    });
    expect(status).toBe(400);
    expect(body.error).toContain("not a directory");
  });

  it("400s an invalid role and writes nothing", async () => {
    const url = await bootProject();
    const before = await readFile(path.join(cwd, "cuesheet.toml"), "utf8");
    const { status } = await post<ApiError>(url, "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "pilot",
      workspace: await workspace(),
    });
    expect(status).toBe(400);
    expect(await readFile(path.join(cwd, "cuesheet.toml"), "utf8")).toBe(
      before,
    );
  });

  it("400s an id that would escape the runs directory", async () => {
    const url = await bootProject();
    const { status } = await post<ApiError>(url, "/stations", {
      id: "../escape",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    expect(status).toBe(400);
  });

  it("is reachable under /api too, which is what the Desk calls", async () => {
    await boot();
    const { status } = await post<Added>(apiProjectBase(), "/stations", {
      id: "qwen",
      harness: "ollama",
      role: "worker",
      workspace: await workspace(),
    });
    expect(status).toBe(201);
  });
});
