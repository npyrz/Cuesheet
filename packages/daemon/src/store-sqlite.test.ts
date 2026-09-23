import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileRunStore } from "./store.js";
import {
  openSqliteRunStore,
  RunsSchemaTooNewError,
  RUNS_DB_FILENAME,
  sqliteAvailable,
  type SqliteRunStore,
} from "./store-sqlite.js";
import { RUN_STORE_CONTRACT } from "./store-contract.js";
import { createRunIdFactory } from "./ids.js";
import type { RunEvent } from "@cuesheet/core";

const execFileAsync = promisify(execFile);

let root: string;
/** Closed in `afterEach`: an open database keeps a Windows directory alive. */
const opened: SqliteRunStore[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cuesheet-sqlite-"));
});

afterEach(async () => {
  for (const store of opened.splice(0)) await store.close();
});

async function store(options: { startAt?: number } = {}) {
  const opened_ = await openSqliteRunStore({
    root,
    newId: createRunIdFactory(options.startAt ?? 0),
  });
  opened.push(opened_);
  return opened_;
}

function text(runId: string, chunk: string): RunEvent {
  return {
    t: "text",
    at: "2026-09-10T14:22:33.104Z",
    runId,
    stationId: "opus",
    chunk,
  };
}

describe("the RunStore contract", () => {
  // The same list `store.test.ts` runs against the file store. Two backends,
  // one definition of what a run store does — which is the claim Step 10 made
  // when it cut the interface and Step 52 is the first opportunity to test.
  for (const check of RUN_STORE_CONTRACT) {
    it(check.name, async () => {
      await check.run(await store());
    });
  }
});

describe("the database file", () => {
  it("is created inside the project's runs directory", async () => {
    await store();
    const entries = await readdir(root);
    expect(entries).toContain(RUNS_DB_FILENAME);
  });

  it("keeps runs across a close and a reopen", async () => {
    const first = await store();
    const created = await first.create({ prompt: "ship it", workspace: "/ws" });
    await first.append(created.id, text(created.id, "streamed"));
    await first.finish(created.id, { status: "done", diff: "patch" });
    await first.close();

    const second = await store();
    const stored = await second.get(created.id);
    expect(stored?.run.status).toBe("done");
    expect(stored?.events).toHaveLength(1);
    expect(stored?.diff).toBe("patch");
  });

  it("closes idempotently and releases the directory", async () => {
    // Windows will not remove a directory holding an open file handle, so a
    // store that cannot be closed makes its own runs directory permanent.
    // This is also what `ProjectRuntime.close()` depends on.
    const s = await store();
    await s.create({ prompt: "hi", workspace: "/ws" });
    await s.close();
    await s.close();

    await rm(root, { recursive: true });
    await expect(readdir(root)).rejects.toThrow();
    root = await mkdtemp(path.join(tmpdir(), "cuesheet-sqlite-"));
  });

  it("refuses a database written by a newer build rather than writing to it", async () => {
    const s = await store();
    await s.close();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(path.join(root, RUNS_DB_FILENAME));
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    await expect(openSqliteRunStore({ root })).rejects.toThrow(
      RunsSchemaTooNewError,
    );
  });

  it("is readable by a second process using nothing but node:sqlite", async () => {
    // Step 10 proved the file layout portable with a bare `node -e` reader.
    // The same question applies harder to a database: if only our code can
    // read it, a stranger with a broken install has no way in.
    const s = await store();
    const created = await s.create({ prompt: "ship it", workspace: "/ws" });
    await s.append(created.id, text(created.id, "streamed"));
    await s.finish(created.id, { status: "done" });
    await s.close();

    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      const run = JSON.parse(db.prepare("SELECT doc FROM runs").get().doc);
      const events = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
      process.stdout.write(JSON.stringify({
        id: run.id, status: run.status, prompt: run.prompt, events,
      }));
    `;
    const { stdout } = await execFileAsync(process.execPath, [
      "-e",
      script,
      path.join(root, RUNS_DB_FILENAME),
    ]);

    expect(JSON.parse(stdout)).toEqual({
      id: created.id,
      status: "done",
      prompt: "ship it",
      events: 1,
    });
  });
});

describe("adopting an existing file store", () => {
  async function seedFileRuns() {
    const files = createFileRunStore({ root, newId: createRunIdFactory(0) });
    const first = await files.create({ prompt: "older", workspace: "/ws" });
    await files.append(first.id, text(first.id, "from the old store"));
    await files.finish(first.id, {
      status: "done",
      cost: { tokensIn: 3, tokensOut: 4, usd: 0.02 },
      diff: "--- a/x\n+++ b/x\n",
    });
    const second = await files.create({ prompt: "newer", workspace: "/ws" });
    return { first, second };
  }

  it("imports the run directories an earlier build wrote", async () => {
    const { first, second } = await seedFileRuns();

    const s = await store({ startAt: 500 });
    expect(s.importedRuns).toBe(2);
    expect((await s.list()).map((run) => run.id)).toEqual([
      second.id,
      first.id,
    ]);

    const stored = await s.get(first.id);
    expect(stored?.run.status).toBe("done");
    expect(stored?.run.cost.usd).toBe(0.02);
    expect(stored?.events).toHaveLength(1);
    expect(stored?.diff).toBe("--- a/x\n+++ b/x\n");
  });

  it("leaves the directories on disk, so files stays a working answer", async () => {
    const { first } = await seedFileRuns();
    await store();

    const entries = await readdir(path.join(root, first.id));
    expect(entries.sort()).toEqual(["diff.patch", "events.jsonl", "run.json"]);
  });

  it("imports once, not on every open", async () => {
    const { first } = await seedFileRuns();
    const s = await store();
    await s.append(first.id, text(first.id, "written after the import"));
    await s.close();

    const reopened = await store();
    expect(reopened.importedRuns).toBe(0);
    expect(await reopened.list()).toHaveLength(2);
    // Two events rather than three: the imported one, plus the one added
    // since. A second import would have duplicated the first.
    expect((await reopened.get(first.id))?.events).toHaveLength(2);
  });

  it("ignores a runs directory that holds no runs", async () => {
    await writeFile(path.join(root, ".DS_Store"), "junk", "utf8");
    const s = await store();
    expect(s.importedRuns).toBe(0);
    expect(await s.list()).toEqual([]);
  });
});

describe("scale", () => {
  /**
   * Step 52's done-when: "a store with 10,000 runs opens the Desk as fast as
   * one with ten".
   *
   * What the Desk actually asks for on open is `list(limit)` — the project
   * view's run list — so that is what is measured, against the same query on
   * a ten-run store. The bound is a ratio *plus* a floor: a ratio alone turns
   * a sub-millisecond baseline into a coin flip on a loaded CI runner, and an
   * absolute bound alone says nothing about scaling. The file store fails
   * this by construction — it opens one `run.json` per row returned and
   * `readdir`s ten thousand entries to find them — which is why this test
   * lives here and not in the contract.
   */
  it("answers a page of runs off an index, not off every record", async () => {
    const small = await openSqliteRunStore({
      root: await mkdtemp(path.join(tmpdir(), "cuesheet-sqlite-small-")),
      newId: createRunIdFactory(0),
    });
    opened.push(small);
    for (let i = 0; i < 10; i += 1) {
      await small.create({ prompt: `run ${i}`, workspace: "/ws" });
    }

    // A clock that advances a millisecond per run: ten thousand ids from one
    // factory would otherwise wrap its four-digit counter and collide.
    let tick = Date.parse("2026-01-01T00:00:00.000Z");
    const large = await openSqliteRunStore({
      root,
      newId: createRunIdFactory(0),
      now: () => new Date((tick += 1)),
    });
    opened.push(large);
    for (let i = 0; i < 10_000; i += 1) {
      await large.create({ prompt: `run ${i}`, workspace: "/ws" });
    }
    expect(await large.list(1)).toHaveLength(1);

    const time = async (s: SqliteRunStore): Promise<number> => {
      const started = performance.now();
      for (let i = 0; i < 20; i += 1) await s.list(50);
      return performance.now() - started;
    };

    await time(large);
    const ten = await time(small);
    const tenThousand = await time(large);

    expect(tenThousand).toBeLessThan(Math.max(ten * 5, 250));
  });
});

describe("availability", () => {
  it("reports that this runtime has node:sqlite", async () => {
    // If this ever fails, the fallback in `store-backend.ts` is the thing
    // keeping the daemon alive, and the default backend is quietly files.
    expect(await sqliteAvailable()).toBe(true);
  });
});
