/**
 * Step 34's done-when: **a switch is not a stop.**
 *
 * Switching projects is a client action — a socket closes and another opens —
 * and the thing that has to survive it belongs to the daemon: the queue, the
 * run store and the event bus live on a project's runtime, not on anybody's
 * connection. This file is the evidence for what Step 32's retrospective could
 * only argue from the design: start a long run in A, drop A's socket, attach to
 * B, assert A's run is still running and B never saw it, then reattach to A and
 * assert its log comes back whole.
 *
 * **What this proves and what it does not.** The bus replay is bounded by
 * `replayLimit`, so the socket backlog alone cannot be the answer to "no gap in
 * the log" — a run that emits more than that while you are away *does* gap on
 * the bus. What closes the gap is the resync's `GET /runs/:id`, because the
 * store is authoritative and the bus is a convenience. Both halves are asserted
 * below, separately, so neither is taken on trust from the other.
 */
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import WebSocket from "ws";
import type { HostEnv, Project, Run, RunEvent } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import type { ExecutionContext, RunExecutor } from "./executor.js";

let env: HostEnv;
let home: string;
let daemon: DaemonHandle;

/** Resolved when the long run starts; `release` is what finally ends it. */
let started: Promise<ExecutionContext>;
let release: () => void;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-sw-")));
  env = { platform: process.platform, homedir: home };
});

afterEach(async () => {
  release?.();
  await daemon?.close();
  await rm(home, { recursive: true, force: true });
});

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

/**
 * A run that streams and does not finish until it is told to.
 *
 * The whole point of the constraint is that runs are long: a run that ended
 * while the test was looking away would prove nothing about whether looking
 * away ended it.
 */
function longRun(): RunExecutor {
  let announce: (ctx: ExecutionContext) => void;
  started = new Promise<ExecutionContext>((resolve) => {
    announce = resolve;
  });
  return (ctx) => {
    announce(ctx);
    return new Promise((resolve) => {
      release = () =>
        resolve({
          status: "done",
          cost: { tokensIn: 0, tokensOut: 0 },
          durationMs: 0,
        });
      ctx.signal.addEventListener("abort", release);
    });
  };
}

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

/** One client's connection to one project, as the Desk's socket would be. */
interface Attachment {
  seen: RunEvent[];
  close(): Promise<void>;
}

async function attach(projectId: string): Promise<Attachment> {
  const seen: RunEvent[] = [];
  const socket = new WebSocket(
    `${daemon.url.replace("http", "ws")}/projects/${projectId}/ws`,
  );
  socket.on("message", (data) =>
    seen.push(JSON.parse(String(data)) as RunEvent),
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return {
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      }),
  };
}

async function waitFor(
  what: string,
  ready: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 4_000;
  // `await` on the predicate, not just on the sleep: an earlier version took a
  // synchronous one and was handed `async () => …`, which is a promise and so
  // always truthy — the wait passed instantly and asserted nothing.
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function text(ctx: ExecutionContext, chunk: string): void {
  ctx.emit({
    t: "text",
    at: new Date().toISOString(),
    runId: ctx.run.id,
    stationId: "opus",
    chunk,
  });
}

const chunks = (events: RunEvent[]): string[] =>
  events
    .filter((e) => e.t === "text")
    .map((e) => (e as { chunk: string }).chunk);

/** Two projects, a run streaming in the first, a client attached to it. */
async function twoProjects(): Promise<{
  api: Project;
  web: Project;
  run: Run;
  ctx: ExecutionContext;
  client: Attachment;
}> {
  const apiRoot = await projectFolder("api", "opus");
  const webRoot = await projectFolder("web", "sonnet");
  daemon = await startDaemon({
    port: 0,
    env,
    cwd: home,
    writeLockFile: false,
    executor: longRun(),
  });
  const api = await open(apiRoot);
  const web = await open(webRoot);

  const client = await attach(api.id);
  // `POST /runs` answers `{ runId }` and returns before the queue picks the
  // run up; the executor's own context is the record, and waiting on it is
  // also how the test knows the run is actually under way.
  await json<{ runId: string }>(`${daemon.url}/projects/${api.id}/runs`, {
    method: "POST",
    body: JSON.stringify({ prompt: "a long one" }),
  });
  const ctx = await started;
  const run = ctx.run;
  text(ctx, "one");
  await waitFor("the first chunk", () => chunks(client.seen).includes("one"));

  return { api, web, run, ctx, client };
}

const storedEvents = async (
  projectId: string,
  runId: string,
): Promise<RunEvent[]> =>
  (
    await json<{ events: RunEvent[] }>(
      `${daemon.url}/projects/${projectId}/runs/${runId}`,
    )
  ).events;

const statusOf = async (projectId: string, runId: string): Promise<string> =>
  (
    await json<{ run: Run }>(
      `${daemon.url}/projects/${projectId}/runs/${runId}`,
    )
  ).run.status;

it("leaves the run streaming when its client switches away", async () => {
  const { api, web, run, ctx, client } = await twoProjects();

  // The switch: A's socket closes, B's opens. Nothing else happens.
  await client.close();
  const elsewhere = await attach(web.id);

  // The run keeps going, and keeps being written to, with nobody watching.
  text(ctx, "two");
  await waitFor("the unwatched event to reach the store", async () =>
    chunks(await storedEvents(api.id, run.id)).includes("two"),
  );

  expect(await statusOf(api.id, run.id)).toBe("running");
  // Not orphaned: it is still the project's active run, not a record the
  // queue has forgotten about.
  expect(daemon.projects.live()).toContain(api.id);

  await elsewhere.close();
});

it("never shows one project's run to a client attached to another", async () => {
  const { api, web, run, ctx, client } = await twoProjects();

  await client.close();
  const elsewhere = await attach(web.id);
  text(ctx, "two");
  text(ctx, "three");
  // Give anything that was going to leak the chance to arrive: wait until the
  // events are on disk in A, by which point they have long since fanned out.
  await waitFor("the events to land in the project being left", async () =>
    chunks(await storedEvents(api.id, run.id)).includes("three"),
  );

  expect(elsewhere.seen).toEqual([]);
  await elsewhere.close();
});

it("replays the log on the way back, with no gap", async () => {
  const { api, web, run, ctx, client } = await twoProjects();

  await client.close();
  const elsewhere = await attach(web.id);
  // Everything that happens while the Desk is looking at the other project.
  text(ctx, "two");
  text(ctx, "three");
  await elsewhere.close();

  // Switch back.
  const back = await attach(api.id);
  await waitFor("the backlog to replay", () =>
    chunks(back.seen).includes("three"),
  );

  // The bus replayed what it held, in order, including what was emitted while
  // this client was attached to the other project.
  expect(chunks(back.seen)).toEqual(["one", "two", "three"]);
  // Still running, and still streaming into the same tile.
  expect(await statusOf(api.id, run.id)).toBe("running");
  text(ctx, "four");
  await waitFor("the run to stream again", () =>
    chunks(back.seen).includes("four"),
  );

  await back.close();
});

/**
 * The half the socket cannot promise. `replayLimit` bounds the bus, so a run
 * noisier than the ring loses its head there — and the Desk's resync does not
 * depend on it, because `GET /runs/:id` reads `events.jsonl`. This is the
 * assertion that "no gap in the log" survives a run that outran the buffer.
 */
it("keeps the whole log in the store even when the bus backlog cannot", async () => {
  const apiRoot = await projectFolder("api", "opus");
  daemon = await startDaemon({
    port: 0,
    env,
    cwd: home,
    writeLockFile: false,
    executor: longRun(),
    replayLimit: 3,
  });
  const api = await open(apiRoot);

  const client = await attach(api.id);
  await json<{ runId: string }>(`${daemon.url}/projects/${api.id}/runs`, {
    method: "POST",
    body: JSON.stringify({ prompt: "a noisy one" }),
  });
  const ctx = await started;
  const run = ctx.run;

  await client.close();
  for (const chunk of ["one", "two", "three", "four", "five"]) {
    text(ctx, chunk);
  }

  // The bus has dropped the head, which is the honest behaviour of a ring.
  const back = await attach(api.id);
  await waitFor("the backlog", () => chunks(back.seen).includes("five"));
  expect(chunks(back.seen)).not.toContain("one");

  // The store has all of it, which is what the Desk actually resyncs from.
  await waitFor("the log to be written", async () =>
    chunks(await storedEvents(api.id, run.id)).includes("five"),
  );
  expect(chunks(await storedEvents(api.id, run.id))).toEqual([
    "one",
    "two",
    "three",
    "four",
    "five",
  ]);

  await back.close();
});

/**
 * "Reopen the project you were last in" — the other half of Step 34, and the
 * reason a switch goes through `POST /projects` rather than being purely
 * client-side. `registry.open` is idempotent by resolved root, so the call that
 * performs a switch is also the call that records it; the daemon and the Desk
 * then read the head of the same recency-ordered list, and there is no second
 * source of truth to keep in step.
 */
it("comes back up on the project switched to, after a restart", async () => {
  const { api, web } = await twoProjects();
  // This daemon booted on a `cwd` with no config and had both projects opened
  // over HTTP afterwards, so it bootstrapped nothing — `defaultProject` is
  // fixed at boot and deliberately does not follow a switch.
  expect(daemon.defaultProject).toBeNull();
  // `web` was opened second, so it is the head of the list right now.
  const before = await json<{ projects: { id: string }[] }>(
    `${daemon.url}/projects`,
  );
  expect(before.projects[0]?.id).toBe(web.id);

  // The switch, exactly as `switchTo` performs it.
  await open(path.join(home, "api"));
  const { projects } = await json<{ projects: { id: string }[] }>(
    `${daemon.url}/projects`,
  );
  expect(projects[0]?.id).toBe(api.id);

  release();
  await daemon.close();
  daemon = await startDaemon({ port: 0, env, cwd: home, writeLockFile: false });
  expect(daemon.defaultProject?.project.id).toBe(api.id);
});

it("switching to a project whose folder has gone is refused, not half-done", async () => {
  const { web } = await twoProjects();
  await rm(path.join(home, "web"), { recursive: true, force: true });

  const response = await fetch(`${daemon.url}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: path.join(home, "web") }),
  });

  expect(response.status).toBe(400);
  // Still listed, so the picker can say `missing` rather than losing it.
  const { projects } = await json<{ projects: { id: string }[] }>(
    `${daemon.url}/projects`,
  );
  expect(projects.map((p) => p.id)).toContain(web.id);
});
