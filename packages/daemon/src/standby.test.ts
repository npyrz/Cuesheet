import { describe, expect, it } from "vitest";
import { createStandbyRegistry, StandbyAbandonedError } from "./standby.js";

const request = {
  runId: "20260910T142233104Z-0000",
  ask: "Write to infra/?",
  kind: "permission" as const,
};

describe("standby registry", () => {
  it("resolves the waiting promise with the answer", async () => {
    const registry = createStandbyRegistry();
    const { standby, answer } = registry.open(request);
    registry.resolve(standby.id, "go");
    await expect(answer).resolves.toBe("go");
  });

  it("records who answered and when", () => {
    const registry = createStandbyRegistry();
    const { standby } = registry.open(request);
    const settled = registry.resolve(standby.id, "no");
    expect(settled?.answer).toBe("no");
    expect(settled?.answeredAt).toBeTypeOf("string");
  });

  it("lists only what is still pending", () => {
    const registry = createStandbyRegistry();
    const { standby } = registry.open(request);
    expect(registry.list()).toHaveLength(1);
    registry.resolve(standby.id, "go");
    expect(registry.list()).toHaveLength(0);
  });

  it("still remembers an answered standby by id", () => {
    const registry = createStandbyRegistry();
    const { standby } = registry.open(request);
    registry.resolve(standby.id, "go");
    expect(registry.get(standby.id)?.answer).toBe("go");
  });

  it("returns null for an unknown or already-answered id", () => {
    const registry = createStandbyRegistry();
    expect(registry.resolve("nope", "go")).toBeNull();
    const { standby } = registry.open(request);
    registry.resolve(standby.id, "go");
    // A second answer must not re-resolve a settled promise.
    expect(registry.resolve(standby.id, "no")).toBeNull();
  });

  it("carries the station through when one is named", () => {
    const registry = createStandbyRegistry();
    const { standby } = registry.open({ ...request, stationId: "opus" });
    expect(standby.stationId).toBe("opus");
  });

  it("omits stationId rather than storing undefined", () => {
    const registry = createStandbyRegistry();
    const { standby } = registry.open(request);
    expect("stationId" in standby).toBe(false);
  });

  it("rejects pending standbys when their run is abandoned", async () => {
    // Otherwise a stopped run leaves a promise nobody will ever resolve and
    // the run sits `running` forever.
    const registry = createStandbyRegistry();
    const { answer } = registry.open(request);
    registry.abandonRun(request.runId, "The run was stopped.");
    await expect(answer).rejects.toThrow(StandbyAbandonedError);
    expect(registry.list()).toHaveLength(0);
  });

  it("leaves other runs' standbys alone when abandoning one", async () => {
    const registry = createStandbyRegistry();
    const mine = registry.open(request);
    const theirs = registry.open({
      ...request,
      runId: "20260910T142233105Z-0001",
    });
    registry.abandonRun(request.runId, "stopped");

    await expect(mine.answer).rejects.toThrow(StandbyAbandonedError);
    expect(registry.list().map((s) => s.id)).toEqual([theirs.standby.id]);
    registry.resolve(theirs.standby.id, "go");
    await expect(theirs.answer).resolves.toBe("go");
  });

  it("issues distinct ids", () => {
    const registry = createStandbyRegistry();
    const ids = new Set(
      Array.from({ length: 20 }, () => registry.open(request).standby.id),
    );
    expect(ids.size).toBe(20);
  });
});
