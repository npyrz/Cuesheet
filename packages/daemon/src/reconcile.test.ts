import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { HostEnv, RunEvent } from "@cuesheet/core";
import { createFileRunStore, readEvents } from "./store.js";
import { createRunIdFactory } from "./ids.js";
import { INTERRUPTED_REASON, reconcileInterruptedRuns } from "./reconcile.js";
import { startDaemon } from "./server.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cuesheet-reconcile-"));
});

function store(startAt = 0) {
  return createFileRunStore({ root, newId: createRunIdFactory(startAt) });
}

function text(runId: string, chunk: string): RunEvent {
  return {
    t: "text",
    at: "2026-09-11T09:00:00.000Z",
    runId,
    stationId: "opus",
    chunk,
  };
}

describe("reconcileInterruptedRuns", () => {
  it("marks a run the crash left running as interrupted", async () => {
    const s = store();
    const run = await s.create({
      prompt: "ship it",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.update(run.id, { status: "running" });

    const repaired = await reconcileInterruptedRuns({ store: s });

    expect(repaired).toEqual([run.id]);
    const after = await s.get(run.id);
    expect(after?.run.status).toBe("interrupted");
    expect(after?.run.error).toBe(INTERRUPTED_REASON);
    expect(after?.run.finishedAt).toBeTruthy();
  });

  it("leaves the partial event log exactly as the crash left it", async () => {
    // The done-when says "with its partial events intact". Appending a
    // synthetic `done` to tidy the record up would be inventing the part
    // nobody witnessed.
    const s = store();
    const run = await s.create({
      prompt: "ship it",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.update(run.id, { status: "running" });
    await s.append(run.id, text(run.id, "half a th"));

    const eventsFile = path.join(root, run.id, "events.jsonl");
    // A hard kill mid-write leaves a torn last line. The reader tolerates it;
    // reconciliation must not "fix" it either.
    await writeFile(
      eventsFile,
      `${await readFile(eventsFile, "utf8")}{"t":"te`,
    );
    const before = await readFile(eventsFile, "utf8");

    await reconcileInterruptedRuns({ store: s });

    expect(await readFile(eventsFile, "utf8")).toBe(before);
    const events = await readEvents(eventsFile);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ t: "text", chunk: "half a th" });
  });

  it("keeps the cost the run had already run up", async () => {
    // Zeroing it would make the record tidy and the ledger wrong, in the
    // user's favour right up until the bill arrives.
    const s = store();
    const run = await s.create({
      prompt: "ship it",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.update(run.id, {
      status: "running",
      cost: { tokensIn: 900, tokensOut: 120, usd: 0.11 },
    });

    await reconcileInterruptedRuns({ store: s });

    expect((await s.get(run.id))?.run.cost).toEqual({
      tokensIn: 900,
      tokensOut: 120,
      usd: 0.11,
    });
  });

  it("does not touch runs that already ended", async () => {
    const s = store();
    const done = await s.create({
      prompt: "one",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.finish(done.id, { status: "done" });
    const stopped = await s.create({
      prompt: "two",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.finish(stopped.id, { status: "stopped" });

    expect(await reconcileInterruptedRuns({ store: s })).toEqual([]);
    expect((await s.get(done.id))?.run.status).toBe("done");
    expect((await s.get(stopped.id))?.run.status).toBe("stopped");
  });

  it("covers every non-terminal status, not just `running`", async () => {
    // A crash during a standby is the nastiest version of this: nobody is
    // ever going to answer that question now.
    const s = store();
    const queued = await s.create({
      prompt: "queued",
      stationIds: ["opus"],
      workspace: root,
    });
    const standby = await s.create({
      prompt: "standby",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.update(standby.id, { status: "standby" });

    const repaired = await reconcileInterruptedRuns({ store: s });

    expect(repaired).toHaveLength(2);
    expect((await s.get(queued.id))?.run.status).toBe("interrupted");
    expect((await s.get(standby.id))?.run.status).toBe("interrupted");
  });

  it("only scans as far back as the limit", async () => {
    const s = store();
    const older = await s.create({
      prompt: "older",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.update(older.id, { status: "running" });
    const newer = await s.create({
      prompt: "newer",
      stationIds: ["opus"],
      workspace: root,
    });
    await s.update(newer.id, { status: "running" });

    expect(await reconcileInterruptedRuns({ store: s, limit: 1 })).toEqual([
      newer.id,
    ]);
    expect((await s.get(older.id))?.run.status).toBe("running");
  });
});

describe("startDaemon", () => {
  it("reconciles before a project can serve a dead run as live", async () => {
    const crashed = store();
    const run = await crashed.create({
      prompt: "ship it",
      stationIds: ["opus"],
      workspace: root,
    });
    await crashed.update(run.id, { status: "running" });

    // A second process over the same runs directory — which is what a
    // relaunch is.
    //
    // Step 32 moved the moment this happens: reconciliation is no longer a
    // single pass at boot but part of building a project's runtime, the first
    // time that project is touched. The guarantee is unchanged and is what
    // this asserts — nothing can *observe* a run left `running` by a dead
    // process — but it is now discharged per project rather than for the one
    // store there used to be.
    const { env, cwd } = await isolatedHome();
    const handle = await startDaemon({
      port: 0,
      env,
      cwd,
      store: store(),
      writeLockFile: false,
    });
    try {
      const project = handle.defaultProject;
      expect(project).not.toBeNull();
      const response = await fetch(
        `${handle.url}/projects/${project!.project.id}/runs/${run.id}`,
      );
      const body = (await response.json()) as { run: { status: string } };
      expect(body.run.status).toBe("interrupted");
    } finally {
      await handle.close();
    }
  });

  it("can be switched off", async () => {
    const crashed = store();
    const run = await crashed.create({
      prompt: "ship it",
      stationIds: ["opus"],
      workspace: root,
    });
    await crashed.update(run.id, { status: "running" });

    const { env, cwd } = await isolatedHome();
    const handle = await startDaemon({
      port: 0,
      env,
      cwd,
      store: store(),
      writeLockFile: false,
      reconcile: false,
    });
    try {
      expect((await store().get(run.id))?.run.status).toBe("running");
    } finally {
      await handle.close();
    }
  });
});

/**
 * A home and a working directory of this test's own, with a config in it.
 *
 * Both are needed now: the config is what `startDaemon` bootstraps a project
 * from, and an isolated home keeps the project registry out of the real
 * `~/.cuesheet/projects.json`. Without the second, running this suite would
 * add entries to the developer's own picker.
 */
async function isolatedHome(): Promise<{ env: HostEnv; cwd: string }> {
  const home = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-rc-home-")),
  );
  const cwd = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-rc-cwd-")),
  );
  await writeFile(
    path.join(cwd, "cuesheet.toml"),
    '[[station]]\nid = "opus"\nharness = "claude-code"\nrole = "engineer"\n',
    "utf8",
  );
  return { env: { platform: process.platform, homedir: home }, cwd };
}
