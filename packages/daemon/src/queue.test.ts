import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent, RunStatus } from "@cuesheet/core";
import { createEventBus } from "./bus.js";
import { createFileRunStore, type RunStore } from "./store.js";
import { createRunQueue, type RunQueue } from "./queue.js";
import { createStandbyRegistry, type StandbyRegistry } from "./standby.js";
import { noopExecutor, type RunExecutor } from "./executor.js";
import { createRunIdFactory } from "./ids.js";

interface Harness {
  queue: RunQueue;
  store: RunStore;
  standbys: StandbyRegistry;
  events: RunEvent[];
  statusesFor(runId: string): RunStatus[];
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cuesheet-queue-"));
});

function harness(executor: RunExecutor = noopExecutor): Harness {
  const store = createFileRunStore({ root, newId: createRunIdFactory() });
  const bus = createEventBus();
  const standbys = createStandbyRegistry();
  const events: RunEvent[] = [];
  bus.attach((event) => events.push(event));
  const queue = createRunQueue({ store, bus, standbys, executor });
  return {
    queue,
    store,
    standbys,
    events,
    statusesFor: (runId) =>
      events
        .filter(
          (e): e is Extract<RunEvent, { t: "status" }> =>
            e.t === "status" && e.runId === runId,
        )
        .map((e) => e.status),
  };
}

const done = (): ReturnType<RunExecutor> =>
  Promise.resolve({
    status: "done" as const,
    cost: { tokensIn: 0, tokensOut: 0 },
    durationMs: 0,
  });

describe("sequential execution", () => {
  it("runs two rapid enqueues one at a time, and records both", async () => {
    // Step 11's done-when. `order` is what proves non-overlap: under any
    // concurrency both `start` marks would appear before the first `end`.
    const order: string[] = [];
    const h = harness(async (ctx) => {
      order.push(`start:${ctx.run.prompt}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${ctx.run.prompt}`);
      return done();
    });

    const a = await h.queue.enqueue({ prompt: "first", workspace: "/ws" });
    const b = await h.queue.enqueue({ prompt: "second", workspace: "/ws" });
    await h.queue.idle();

    expect(order).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);

    for (const run of [a, b]) {
      const stored = await h.store.get(run.id);
      expect(stored?.run.status).toBe("done");
      expect(stored?.run.startedAt).toBeTypeOf("string");
      expect(stored?.run.finishedAt).toBeTypeOf("string");
      expect(stored?.run.result?.status).toBe("done");
    }
  });

  it("never overlaps two runs, even when both are enqueued concurrently", async () => {
    // `enqueue` awaits a store write before taking its place in the queue, so
    // two genuinely concurrent callers race for position and which one goes
    // first is not defined. What *is* guaranteed — and all the single-
    // concurrency promise actually needs — is that they never overlap.
    let inFlight = 0;
    let maxInFlight = 0;
    const h = harness(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return done();
    });

    const runs = await Promise.all([
      h.queue.enqueue({ prompt: "a", workspace: "/ws" }),
      h.queue.enqueue({ prompt: "b", workspace: "/ws" }),
      h.queue.enqueue({ prompt: "c", workspace: "/ws" }),
    ]);
    await h.queue.idle();

    expect(maxInFlight).toBe(1);
    for (const run of runs) {
      expect((await h.store.get(run.id))?.run.status).toBe("done");
    }
  });

  it("runs sequential enqueues in the order they were enqueued", async () => {
    const order: string[] = [];
    const h = harness(async (ctx) => {
      order.push(ctx.run.prompt);
      return done();
    });

    for (const prompt of ["one", "two", "three"]) {
      await h.queue.enqueue({ prompt, workspace: "/ws" });
    }
    await h.queue.idle();

    expect(order).toEqual(["one", "two", "three"]);
  });

  it("emits queued then running then done for one run", async () => {
    const h = harness(() => done());
    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();
    expect(h.statusesFor(run.id)).toEqual(["queued", "running", "done"]);
  });

  it("persists every streamed event to the run log", async () => {
    const h = harness(async (ctx) => {
      ctx.emit({
        t: "text",
        at: new Date().toISOString(),
        runId: ctx.run.id,
        stationId: "opus",
        chunk: "thinking",
      });
      return done();
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();

    const stored = await h.store.get(run.id);
    // The executor called `emit` once; the queue is responsible for the log,
    // so no harness has to remember to write to disk.
    expect(
      stored?.events.some((e) => e.t === "text" && e.chunk === "thinking"),
    ).toBe(true);
    expect(stored?.events.some((e) => e.t === "done")).toBe(true);
  });

  it("reports the run as active while it runs, and idle after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(async () => {
      await gate;
      return done();
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.queue.activeRunId()).toBe(run.id);

    release();
    await h.queue.idle();
    expect(h.queue.activeRunId()).toBeNull();
  });
});

describe("failure", () => {
  it("marks a throwing executor failed and records the message", async () => {
    const h = harness(() => Promise.reject(new Error("harness exited 1")));
    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();

    const stored = await h.store.get(run.id);
    expect(stored?.run.status).toBe("failed");
    expect(stored?.run.error).toBe("harness exited 1");
    expect(stored?.events.some((e) => e.t === "error")).toBe(true);
  });

  it("keeps running the queue after one run fails", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return done();
    });

    await h.queue.enqueue({ prompt: "bad", workspace: "/ws" });
    const second = await h.queue.enqueue({ prompt: "good", workspace: "/ws" });
    await h.queue.idle();

    // A failed run must not strand every run behind it.
    expect((await h.store.get(second.id))?.run.status).toBe("done");
  });
});

describe("stop", () => {
  it("aborts a running run via the signal", async () => {
    const h = harness(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await new Promise((r) => setTimeout(r, 5));
    expect(await h.queue.stop(run.id)).toBe("stopped-running");
    await h.queue.idle();

    const stored = await h.store.get(run.id);
    expect(stored?.run.status).toBe("stopped");
    // An abort is the operator's own doing, not an error to show them.
    expect(stored?.events.some((e) => e.t === "error")).toBe(false);
  });

  it("removes a queued run so it never starts", async () => {
    // The case the naive implementation misses: a queued run has no controller
    // to abort, so aborting alone lets it start a moment after the stop.
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(async (ctx) => {
      started.push(ctx.run.prompt);
      await gate;
      return done();
    });

    await h.queue.enqueue({ prompt: "running", workspace: "/ws" });
    const queued = await h.queue.enqueue({
      prompt: "queued",
      workspace: "/ws",
    });
    await new Promise((r) => setTimeout(r, 5));

    expect(await h.queue.stop(queued.id)).toBe("stopped-queued");
    release();
    await h.queue.idle();

    expect(started).toEqual(["running"]);
    expect((await h.store.get(queued.id))?.run.status).toBe("stopped");
    expect(h.statusesFor(queued.id)).toEqual(["queued", "stopped"]);
  });

  it("reports not-found for an unknown run", async () => {
    const h = harness();
    expect(await h.queue.stop("20260910T142233104Z-9999")).toBe("not-found");
  });

  it("reports already-finished for a completed run", async () => {
    const h = harness(() => done());
    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();
    expect(await h.queue.stop(run.id)).toBe("already-finished");
  });

  it("marks a run stopped even if the executor returns done after the abort", async () => {
    // An executor that ignores the signal must not turn a stop into a success:
    // the operator pressed the button and the list has to say so.
    const h = harness(async (ctx) => {
      await new Promise((r) => setTimeout(r, 15));
      void ctx;
      return done();
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await new Promise((r) => setTimeout(r, 5));
    await h.queue.stop(run.id);
    await h.queue.idle();

    expect((await h.store.get(run.id))?.run.status).toBe("stopped");
  });
});

describe("cost", () => {
  it("prefers the harness's own total when it reports one", async () => {
    // The fixture makes the two disagree on purpose. With matching numbers
    // the assertion cannot tell which value the code actually used, and the
    // test passes either way.
    const h = harness(async (ctx) => {
      const at = new Date().toISOString();
      ctx.emit({
        t: "cost",
        at,
        runId: ctx.run.id,
        stationId: "a",
        tokensIn: 10,
        tokensOut: 5,
        usd: 0.01,
      });
      return {
        status: "done" as const,
        cost: { tokensIn: 99, tokensOut: 98, usd: 9.5 },
        durationMs: 1,
      };
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();

    // The harness knows its own billing; a sum of streamed deltas can
    // double-count or miss a final settlement.
    expect((await h.store.get(run.id))?.run.cost).toEqual({
      tokensIn: 99,
      tokensOut: 98,
      usd: 9.5,
    });
  });

  it("falls back to streamed events when the harness reports no total", async () => {
    const h = harness(async (ctx) => {
      const at = new Date().toISOString();
      ctx.emit({
        t: "cost",
        at,
        runId: ctx.run.id,
        stationId: "a",
        tokensIn: 10,
        tokensOut: 5,
        usd: 0.01,
      });
      ctx.emit({
        t: "cost",
        at,
        runId: ctx.run.id,
        stationId: "a",
        tokensIn: 3,
        tokensOut: 2,
        usd: 0.02,
      });
      // A harness that streams costs but never sums them must not erase the
      // spend that was actually observed — M2's ledger reads this field, and
      // under-counting is the direction that lets someone blow past a cap.
      return {
        status: "done" as const,
        cost: { tokensIn: 0, tokensOut: 0 },
        durationMs: 1,
      };
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();

    expect((await h.store.get(run.id))?.run.cost).toEqual({
      tokensIn: 13,
      tokensOut: 7,
      usd: 0.03,
    });
  });

  it("leaves usd absent when no harness priced the run", async () => {
    const h = harness(async (ctx) => {
      ctx.emit({
        t: "cost",
        at: new Date().toISOString(),
        runId: ctx.run.id,
        stationId: "a",
        tokensIn: 4,
        tokensOut: 1,
      });
      throw new Error("died after counting tokens");
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();

    const cost = (await h.store.get(run.id))?.run.cost;
    expect(cost).toEqual({ tokensIn: 4, tokensOut: 1 });
    // Absent, not zero — "we don't know the price" and "it was free" are
    // different claims to make in a limits ledger.
    expect(cost && "usd" in cost).toBe(false);
  });
});

describe("standbys", () => {
  it("pauses for an answer and resumes with it", async () => {
    let answered: string | undefined;
    const h = harness(async (ctx) => {
      answered = await ctx.ask({ ask: "Write to infra/?", kind: "permission" });
      return done();
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await new Promise((r) => setTimeout(r, 5));

    const [pending] = h.standbys.list();
    expect(pending?.ask).toBe("Write to infra/?");
    expect(h.statusesFor(run.id)).toContain("standby");

    h.standbys.resolve(pending!.id, "go");
    await h.queue.idle();

    expect(answered).toBe("go");
    expect((await h.store.get(run.id))?.run.status).toBe("done");
    expect(h.statusesFor(run.id)).toEqual([
      "queued",
      "running",
      "standby",
      "running",
      "done",
    ]);
  });

  it("records the standby in the run log", async () => {
    const h = harness(async (ctx) => {
      const promise = ctx.ask({ ask: "Proceed?", kind: "hold" });
      await new Promise((r) => setTimeout(r, 5));
      const [pending] = h.standbys.list();
      h.standbys.resolve(pending!.id, "no");
      await promise;
      return done();
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await h.queue.idle();

    expect(
      (await h.store.get(run.id))?.events.some(
        (e) => e.t === "standby" && e.ask === "Proceed?",
      ),
    ).toBe(true);
  });

  it("abandons a pending standby when the run is stopped", async () => {
    const h = harness(async (ctx) => {
      await ctx.ask({ ask: "Proceed?", kind: "hold" });
      return done();
    });

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await new Promise((r) => setTimeout(r, 5));
    await h.queue.stop(run.id);
    await h.queue.idle();

    // Otherwise a stopped run leaves a promise nobody will ever resolve, and
    // the run sits `running` forever.
    expect(h.standbys.list()).toHaveLength(0);
    expect((await h.store.get(run.id))?.run.status).toBe("stopped");
  });
});

describe("shutdown", () => {
  it("marks the active run interrupted, not failed", async () => {
    const h = harness(
      (ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    const run = await h.queue.enqueue({ prompt: "hi", workspace: "/ws" });
    await new Promise((r) => setTimeout(r, 5));
    await h.queue.shutdown();

    // Step 23's bar: a run interrupted by a quit must land somewhere terminal
    // and readable, never sit `running` forever.
    const stored = await h.store.get(run.id);
    expect(stored?.run.status).toBe("interrupted");
    expect(stored?.run.finishedAt).toBeTypeOf("string");
  });

  it("marks still-queued runs interrupted and never starts them", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const h = harness(async (ctx) => {
      started.push(ctx.run.prompt);
      await gate;
      return done();
    });

    await h.queue.enqueue({ prompt: "running", workspace: "/ws" });
    const queued = await h.queue.enqueue({
      prompt: "queued",
      workspace: "/ws",
    });
    await new Promise((r) => setTimeout(r, 5));

    release();
    await h.queue.shutdown();

    expect(started).toEqual(["running"]);
    expect((await h.store.get(queued.id))?.run.status).toBe("interrupted");
  });
});
