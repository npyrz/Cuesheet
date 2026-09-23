/**
 * The run store contract, as something executable.
 *
 * Step 10 cut `RunStore` as an interface so the backend could be swapped
 * "without touching a caller", and Step 52 is where that claim is tested
 * rather than asserted: there are two implementations now, and the honest way
 * to say they are interchangeable is to run one suite against both.
 *
 * Note this file imports no test framework, for the same reason
 * `harness/contract.ts` does not: a store backend written outside this repo —
 * Postgres for a shared daemon, a memory store for a test double — should be
 * able to check itself without adopting our runner. Failures are thrown by
 * `node:assert`, which every runner reports as an ordinary error.
 *
 * Each check is handed a **fresh, empty store**. Sharing one across checks
 * would make list ordering depend on what ran before it, which is how a suite
 * ends up asserting its own execution order.
 */
import assert from "node:assert/strict";
import { isTerminalStatus, type Run, type RunEvent } from "@cuesheet/core";
import { RunNotFoundError, type RunStore } from "./store.js";

export interface RunStoreCheck {
  /** Reads as a test name, because that is what a caller registers it as. */
  readonly name: string;
  /** Throws on failure. The store is empty and belongs to this check alone. */
  run(store: RunStore): Promise<void>;
}

const MISSING_RUN = "20260910T142233104Z-9999";

function text(runId: string, chunk: string): RunEvent {
  return {
    t: "text",
    at: "2026-09-10T14:22:33.104Z",
    runId,
    stationId: "opus",
    chunk,
  };
}

function chunks(events: readonly RunEvent[]): string[] {
  return events.map((event) => (event.t === "text" ? event.chunk : event.t));
}

function ids(runs: readonly Run[]): string[] {
  return runs.map((run) => run.id);
}

/**
 * Every behaviour a `RunStore` promises, whatever it does with the bytes.
 *
 * What is deliberately *not* here: anything about the medium. An atomic
 * rename, a tolerated half-written JSONL line and a stale `.tmp` file are
 * properties of the file store and stay in `store.test.ts`; WAL mode and the
 * import of an existing directory tree belong to the SQLite store. A contract
 * that named either would stop being a contract and become one
 * implementation's specification.
 */
export const RUN_STORE_CONTRACT: readonly RunStoreCheck[] = [
  {
    name: "creates a queued run with zeroed cost",
    async run(store) {
      const created = await store.create({
        prompt: "ship it",
        workspace: "/ws",
      });
      assert.equal(created.status, "queued");
      assert.equal(created.kind, "prompt");
      assert.equal(created.prompt, "ship it");
      assert.equal(created.workspace, "/ws");
      assert.deepEqual(created.cost, { tokensIn: 0, tokensOut: 0 });
      assert.deepEqual(created.stationIds, []);
      assert.ok(created.createdAt, "createdAt must be stamped at creation");
    },
  },
  {
    name: "omits absent optional fields rather than storing undefined",
    async run(store) {
      // `exactOptionalPropertyTypes` is on, and a backend that round-trips an
      // absent field as an explicit `undefined` breaks `"cuesheetId" in run`
      // for every caller that asks. Checked after a read rather than on the
      // return value, so a store that only gets this right in memory fails.
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      const stored = await store.get(created.id);
      assert.ok(stored, "a created run must be readable back");
      assert.equal("cuesheetId" in stored.run, false);
      assert.equal("finishedAt" in stored.run, false);
      assert.equal("error" in stored.run, false);
    },
  },
  {
    name: "round-trips every field a run was created with",
    async run(store) {
      const created = await store.create({
        prompt: "ship it",
        workspace: "/ws",
        kind: "incident",
        cuesheetId: "ship",
        stationIds: ["opus", "codex"],
      });
      const stored = await store.get(created.id);
      assert.deepEqual(stored?.run, created);
    },
  },
  {
    name: "round-trips events in order",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      await store.append(created.id, text(created.id, "one"));
      await store.append(created.id, text(created.id, "two"));

      const stored = await store.get(created.id);
      assert.deepEqual(chunks(stored?.events ?? []), ["one", "two"]);
    },
  },
  {
    name: "keeps each event variant's fields through a round trip",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      const events: RunEvent[] = [
        {
          t: "status",
          at: "2026-09-10T14:22:33.104Z",
          runId: created.id,
          status: "running",
        },
        {
          t: "tool",
          at: "2026-09-10T14:22:33.105Z",
          runId: created.id,
          stationId: "opus",
          name: "edit",
          input: { path: "a.ts", nested: [1, 2, { deep: true }] },
        },
        {
          t: "denial",
          at: "2026-09-10T14:22:33.106Z",
          runId: created.id,
          reason: "outside the leash",
          path: "/etc/passwd",
        },
      ];
      for (const event of events) await store.append(created.id, event);

      const stored = await store.get(created.id);
      assert.deepEqual(stored?.events, events);
    },
  },
  {
    name: "serializes concurrent appends without dropping or interleaving",
    async run(store) {
      // Fifty un-awaited appends must all land, in issue order. On the file
      // store that is the per-run write chain; any backend has to hold it,
      // because the queue fires appends without awaiting them.
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          store.append(created.id, text(created.id, String(i))),
        ),
      );

      const stored = await store.get(created.id);
      assert.equal(stored?.events.length, 50);
      assert.deepEqual(
        chunks(stored?.events ?? []),
        Array.from({ length: 50 }, (_, i) => String(i)),
      );
    },
  },
  {
    name: "keeps one run's events out of another's log",
    async run(store) {
      const a = await store.create({ prompt: "a", workspace: "/ws" });
      const b = await store.create({ prompt: "b", workspace: "/ws" });
      await store.append(a.id, text(a.id, "for-a"));
      await store.append(b.id, text(b.id, "for-b"));

      assert.deepEqual(chunks((await store.get(a.id))?.events ?? []), [
        "for-a",
      ]);
      assert.deepEqual(chunks((await store.get(b.id))?.events ?? []), [
        "for-b",
      ]);
    },
  },
  {
    name: "returns null for a run that does not exist",
    async run(store) {
      assert.equal(await store.get(MISSING_RUN), null);
    },
  },
  {
    name: "stamps startedAt on the queued to running transition",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      const updated = await store.update(created.id, {
        status: "running",
        startedAt: "2026-09-10T14:22:34.000Z",
      });
      assert.equal(updated.status, "running");
      assert.equal(updated.startedAt, "2026-09-10T14:22:34.000Z");
      assert.equal(
        (await store.get(created.id))?.run.startedAt,
        "2026-09-10T14:22:34.000Z",
      );
    },
  },
  {
    name: "leaves the fields a patch omits alone",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      await store.update(created.id, {
        status: "running",
        startedAt: "2026-09-10T14:22:34.000Z",
      });
      const updated = await store.update(created.id, {
        cost: { tokensIn: 5, tokensOut: 6 },
      });
      assert.equal(updated.status, "running");
      assert.equal(updated.startedAt, "2026-09-10T14:22:34.000Z");
      assert.deepEqual(updated.cost, { tokensIn: 5, tokensOut: 6 });
    },
  },
  {
    name: "writes the diff and the terminal state",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      const finished = await store.finish(created.id, {
        status: "done",
        cost: { tokensIn: 10, tokensOut: 20, usd: 0.5 },
        result: {
          status: "done",
          cost: { tokensIn: 10, tokensOut: 20, usd: 0.5 },
          durationMs: 1234,
          diff: { filesChanged: 1, insertions: 3, deletions: 0 },
        },
        diff: "--- a/x\n+++ b/x\n",
      });

      assert.equal(finished.status, "done");
      assert.equal(typeof finished.finishedAt, "string");
      assert.equal(finished.cost.usd, 0.5);
      assert.equal(finished.result?.durationMs, 1234);

      const stored = await store.get(created.id);
      assert.equal(stored?.diff, "--- a/x\n+++ b/x\n");
      assert.deepEqual(stored?.run, finished);
    },
  },
  {
    name: "keeps the cost a run accumulated when finish omits one",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      await store.update(created.id, { cost: { tokensIn: 7, tokensOut: 8 } });
      const finished = await store.finish(created.id, {
        status: "interrupted",
      });
      assert.deepEqual(finished.cost, { tokensIn: 7, tokensOut: 8 });
    },
  },
  {
    name: "records an error message on a failed run",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      const finished = await store.finish(created.id, {
        status: "failed",
        error: "harness exited 1",
      });
      assert.equal(finished.error, "harness exited 1");
      assert.equal(
        (await store.get(created.id))?.run.error,
        "harness exited 1",
      );
    },
  },
  {
    name: "throws RunNotFoundError for a run that was never created",
    async run(store) {
      await assert.rejects(
        () => store.update(MISSING_RUN, { status: "running" }),
        RunNotFoundError,
      );
      await assert.rejects(
        () => store.finish(MISSING_RUN, { status: "done" }),
        RunNotFoundError,
      );
    },
  },
  {
    name: "orders finish after every append issued before it",
    async run(store) {
      // The queue fires appends and awaits `finish`; if the two can overtake
      // each other, a run's last streamed output lands after it ended.
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      void store.append(created.id, text(created.id, "streamed"));
      await store.finish(created.id, { status: "done" });

      const stored = await store.get(created.id);
      assert.equal(stored?.events.length, 1);
      assert.equal(stored?.run.status, "done");
    },
  },
  {
    name: "keeps the record readable across many rewrites",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      for (let i = 0; i < 20; i += 1) {
        await store.update(created.id, { cost: { tokensIn: i, tokensOut: i } });
        const stored = await store.get(created.id);
        assert.equal(stored?.run.cost.tokensIn, i);
      }
    },
  },
  {
    name: "serves the diff without the event log",
    async run(store) {
      const created = await store.create({ prompt: "hi", workspace: "/ws" });
      assert.equal(await store.getDiff(created.id), null);
      await store.finish(created.id, { status: "done", diff: "patch text" });
      assert.equal(await store.getDiff(created.id), "patch text");
      assert.equal(await store.getDiff(MISSING_RUN), null);
    },
  },
  {
    name: "lists runs newest first",
    async run(store) {
      const first = await store.create({ prompt: "a", workspace: "/ws" });
      const second = await store.create({ prompt: "b", workspace: "/ws" });
      const third = await store.create({ prompt: "c", workspace: "/ws" });

      assert.deepEqual(ids(await store.list()), [
        third.id,
        second.id,
        first.id,
      ]);
    },
  },
  {
    name: "honours a list limit",
    async run(store) {
      await store.create({ prompt: "a", workspace: "/ws" });
      const second = await store.create({ prompt: "b", workspace: "/ws" });
      assert.deepEqual(ids(await store.list(1)), [second.id]);
    },
  },
  {
    name: "is an empty list before anything has been created",
    async run(store) {
      assert.deepEqual(await store.list(), []);
    },
  },
  {
    name: "reports unfinished runs, when it answers that question at all",
    async run(store) {
      // Optional by design — see `RunStore.unfinished`. A store that offers it
      // has to get it right; one that does not is reconciled by a newest-first
      // scan instead, and skipping here is the honest outcome rather than a
      // hole in the contract.
      if (!store.unfinished) return;

      const queued = await store.create({ prompt: "a", workspace: "/ws" });
      const running = await store.create({ prompt: "b", workspace: "/ws" });
      await store.update(running.id, { status: "running" });
      const done = await store.create({ prompt: "c", workspace: "/ws" });
      await store.finish(done.id, { status: "done" });

      const open = await store.unfinished();
      assert.deepEqual(ids(open).sort(), [queued.id, running.id].sort());
      assert.ok(open.every((run) => !isTerminalStatus(run.status)));
    },
  },
];
