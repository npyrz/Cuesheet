/**
 * Step 37's done-when, in four parts: `GET /usage` answers with every
 * harness's windows, never blocks on a hung CLI, and distinguishes measured,
 * not-yet-blocked, unmetered and unknown as four different answers.
 *
 * The fourth clause is the one with teeth. Three of those answers are easy to
 * collapse into "0%" and the resulting strip looks authoritative while being
 * wrong, which is worse than not drawing one.
 */
import { describe, expect, it, vi } from "vitest";
import type { UsageWindow } from "@cuesheet/core";
import { defaultHarnesses } from "@cuesheet/harness";
import { createUsageCache, type UsageSource } from "./usage.js";

function source(
  id: string,
  windows: UsageWindow[] | (() => Promise<UsageWindow[]>),
  vendor = "acme",
): UsageSource {
  return {
    id,
    vendor,
    usage: typeof windows === "function" ? windows : async () => windows,
  };
}

/** Never settles. What a hung CLI looks like from in here. */
const hangs = () => new Promise<UsageWindow[]>(() => undefined);

describe("createUsageCache", () => {
  it("keeps the four answers distinct", async () => {
    const cache = createUsageCache({
      sources: () => [
        source("measured", [
          { window: "weekly", state: "measured", used: 0.34 },
        ]),
        source("status-only", [{ window: "5h", state: "not-blocked" }]),
        source("local", [{ window: "local", state: "unmetered" }]),
        source("silent", []),
      ],
    });

    const { harnesses } = await cache.get();
    const byId = new Map(harnesses.map((h) => [h.harness, h.windows[0]]));

    expect(byId.get("measured")).toMatchObject({
      state: "measured",
      used: 0.34,
    });
    expect(byId.get("status-only")).toMatchObject({ state: "not-blocked" });
    expect(byId.get("local")).toMatchObject({ state: "unmetered" });
    expect(byId.get("silent")).toMatchObject({ state: "unknown" });

    // The point of the union, asserted rather than assumed: nothing except the
    // measured row has a number anybody could draw a bar from.
    for (const id of ["status-only", "local", "silent"]) {
      expect(byId.get(id)).not.toHaveProperty("used");
    }
  });

  it("turns silence into a reason, not into an absent row", async () => {
    // `codex` returns `[]` truthfully — its stream carries token counts and no
    // plan window. A harness that vanished from the response would read as
    // "not installed", which is a different claim.
    const cache = createUsageCache({ sources: () => [source("codex", [])] });
    const { harnesses } = await cache.get();
    expect(harnesses).toHaveLength(1);
    expect(harnesses[0]?.windows[0]).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("no plan windows"),
    });
  });

  it("does not block on a hung CLI, and says which one hung", async () => {
    const cache = createUsageCache({
      sources: () => [source("hung", hangs), source("fine", [])],
      timeoutMs: 20,
    });

    const started = Date.now();
    const { harnesses } = await cache.get();

    // The assertion that matters is that it *returned*; the elapsed check is a
    // guard against the timeout being ignored, with room for a loaded runner.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(harnesses).toHaveLength(2);
    expect(harnesses[0]?.windows[0]).toMatchObject({
      state: "unknown",
      reason: expect.stringContaining("did not report usage"),
    });
  });

  it("reports a thrown read as unknown rather than failing the request", async () => {
    const cache = createUsageCache({
      sources: () => [
        source("broken", () => Promise.reject(new Error("spawn ENOENT"))),
      ],
    });
    const { harnesses } = await cache.get();
    expect(harnesses[0]?.windows[0]).toMatchObject({
      state: "unknown",
      reason: "spawn ENOENT",
    });
  });

  it("serves a cached reading until its TTL expires", async () => {
    const usage = vi.fn(async (): Promise<UsageWindow[]> => [
      { window: "5h", state: "not-blocked" },
    ]);
    let clock = 1_000;
    const cache = createUsageCache({
      sources: () => [{ id: "claude-code", vendor: "anthropic", usage }],
      ttlMs: 100,
      now: () => clock,
    });

    await cache.get();
    await cache.get();
    expect(usage).toHaveBeenCalledTimes(1);

    clock += 101;
    await cache.get();
    expect(usage).toHaveBeenCalledTimes(2);
  });

  it("reads once when two callers arrive on a cold cache", async () => {
    // The same memoize-the-promise rule the project runtimes keep: without it
    // two concurrent pollers each spawn the same CLI, and on a cold Desk open
    // that is exactly what happens.
    let resolve: (windows: UsageWindow[]) => void = () => undefined;
    const usage = vi.fn(() => new Promise<UsageWindow[]>((r) => (resolve = r)));
    const cache = createUsageCache({
      sources: () => [{ id: "slow", vendor: "acme", usage }],
    });

    const both = Promise.all([cache.get(), cache.get()]);
    resolve([{ window: "5h", state: "not-blocked" }]);
    await both;

    expect(usage).toHaveBeenCalledTimes(1);
  });

  it("picks up a harness registered after the cache was built", async () => {
    const sources: UsageSource[] = [source("mock", [])];
    const cache = createUsageCache({ sources: () => sources });
    expect((await cache.get()).harnesses).toHaveLength(1);

    sources.push(source("late", [{ window: "local", state: "unmetered" }]));
    expect((await cache.get()).harnesses).toHaveLength(2);
  });

  it("re-reads after a clear", async () => {
    const usage = vi.fn(async (): Promise<UsageWindow[]> => []);
    const cache = createUsageCache({
      sources: () => [{ id: "x", vendor: "acme", usage }],
    });
    await cache.get();
    cache.clear();
    await cache.get();
    expect(usage).toHaveBeenCalledTimes(2);
  });
});

describe("what a real default build answers", () => {
  it("gives every shipped harness a row, and three different answers", async () => {
    // No spawning: none of the three shipped `usage()` implementations reaches
    // a process. `claude-code` reports what a run overheard, `codex` reports
    // nothing because its stream carries no plan window, and `mock` is
    // genuinely unmetered.
    const cache = createUsageCache({ sources: () => defaultHarnesses() });
    const { harnesses } = await cache.get();

    const states = new Map(
      harnesses.map((h) => [h.harness, h.windows[0]?.state]),
    );
    expect(states.get("mock")).toBe("unmetered");
    // Both of the real ones are honestly silent today — `claude-code` until a
    // run overhears a limit, `codex` permanently. The strip's first job is to
    // render that as a blank row rather than a reassuring one.
    expect(states.get("claude-code")).toBe("unknown");
    expect(states.get("codex")).toBe("unknown");

    // Vendors travel, because the strip groups by plan rather than by harness.
    expect(harnesses.map((h) => h.vendor)).toContain("anthropic");
    expect(harnesses.map((h) => h.vendor)).toContain("openai");
  });
});
