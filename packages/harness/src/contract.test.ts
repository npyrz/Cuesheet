import { mkdtemp, readFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Station } from "@cuesheet/core";
import { exerciseHarness, harnessContractViolations } from "./contract.js";
import { createMockHarness, MOCK_OUTPUT_FILE, mockHarness } from "./mock.js";
import { claudeCodeHarness } from "./claude-code.js";
import { createHarnessRegistry, defaultHarnessRegistry } from "./index.js";

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-mock-")));
});

function station(overrides: Partial<Station> = {}): Station {
  return {
    id: "mock-station",
    harness: "mock",
    role: "engineer",
    workspace: root,
    paths: ["**"],
    deny: [".git/**"],
    ...overrides,
  };
}

describe("structural contract", () => {
  it("accepts the built-in harnesses", () => {
    // Step 13's done-when, for both shipped harnesses rather than only the one
    // the contract was written alongside.
    expect(harnessContractViolations(mockHarness)).toEqual([]);
    expect(harnessContractViolations(claudeCodeHarness)).toEqual([]);
  });

  it("names every problem at once, not just the first", () => {
    // Someone porting a harness should see the whole list rather than play
    // whack-a-mole through five runs.
    const problems = harnessContractViolations({
      id: "",
      vendor: "",
      roles: [],
      contextFiles: [],
    });
    expect(problems.length).toBeGreaterThan(4);
    expect(problems.join("\n")).toMatch(/`id`/);
    expect(problems.join("\n")).toMatch(/`vendor`/);
    expect(problems.join("\n")).toMatch(/`run\(\)`/);
  });

  it("rejects an unknown role", () => {
    expect(
      harnessContractViolations({
        ...mockHarness,
        roles: ["engineer", "wizard"],
      }),
    ).toEqual(['`roles` contains unknown role "wizard".']);
  });

  it("rejects a blank vendor, because Gates compare on it", () => {
    // `distinct_vendors = 2` is an equality check over this field. A blank
    // vendor silently defeats the entire point of a Gate.
    expect(
      harnessContractViolations({ ...mockHarness, vendor: "" }).join(),
    ).toMatch(/vendor/);
  });

  it("rejects a non-object", () => {
    expect(harnessContractViolations(null)).toEqual([
      "A harness must be an object.",
    ]);
  });
});

describe("the mock harness under the behavioural contract", () => {
  it("passes, and does real work", async () => {
    const report = await exerciseHarness(mockHarness, { station: station() });
    expect(report.violations).toEqual([]);
    expect(report.result.status).toBe("done");
    // The file is written through the leashed facade, so this also proves the
    // facade allows what it should.
    expect(await readFile(path.join(root, MOCK_OUTPUT_FILE), "utf8")).toContain(
      "Mock run",
    );
  });

  it("streams the event kinds the Desk has to render", async () => {
    // Steps 19–20 build against these. A mock that only emitted `text` would
    // leave the tile grid with nothing to show.
    const report = await exerciseHarness(mockHarness, { station: station() });
    const kinds = new Set(report.events.map((event) => event.t));
    expect(kinds).toContain("text");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("file");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("denial");
  });

  it("raises a standby and continues once answered", async () => {
    const report = await exerciseHarness(mockHarness, {
      station: station(),
      answer: "go",
    });
    expect(report.asks).toHaveLength(1);
    expect(report.result.status).toBe("done");
  });

  it("stops without editing when the standby is refused", async () => {
    const report = await exerciseHarness(mockHarness, {
      station: station(),
      answer: "no",
    });
    expect(report.result.status).toBe("done");
    await expect(
      readFile(path.join(root, MOCK_OUTPUT_FILE), "utf8"),
    ).rejects.toThrow();
  });

  it("has its deliberate denial refused by the leash, without failing the run", async () => {
    // A denial is information, not a crash: an agent that tries one bad path
    // and then does its job is a normal, successful run.
    const report = await exerciseHarness(mockHarness, { station: station() });
    const denial = report.events.find((event) => event.t === "denial");
    expect(denial).toBeDefined();
    expect(report.result.status).toBe("done");
  });

  it("meters what it streamed", async () => {
    const report = await exerciseHarness(mockHarness, { station: station() });
    expect(report.meterTotal.tokensIn).toBeGreaterThan(0);
    expect(report.meterTotal.tokensOut).toBeGreaterThan(0);
    expect(report.result.cost?.tokensOut).toBe(report.meterTotal.tokensOut);
  });

  it("aborts mid-run rather than reporting success", async () => {
    // The queue tells `stopped` from `done` by whether the executor threw, so
    // a harness that swallowed the abort would land a stopped run as `done`.
    const controller = new AbortController();
    const slow = createMockHarness({ stepMs: 50 });
    const running = exerciseHarness(slow, {
      station: station(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(running).rejects.toThrow(/stopped/i);
  });
});

describe("the registry", () => {
  it("stamps the id it looked up onto a probe", async () => {
    // A harness cannot report another's identity, however its probe answers.
    const registry = createHarnessRegistry([{ ...mockHarness, id: "renamed" }]);
    expect((await registry.probe("renamed")).harness).toBe("renamed");
  });

  it("turns a thrown probe into a failed probe, not an exception", async () => {
    // `GET /stations` must not 500 because somebody's binary misbehaved.
    const registry = createHarnessRegistry([
      {
        ...mockHarness,
        id: "explodes",
        probe: () => Promise.reject(new Error("boom")),
      },
    ]);
    const probe = await registry.probe("explodes");
    expect(probe).toMatchObject({ installed: false, error: "boom" });
  });

  it("answers for a harness nobody registered", async () => {
    const probe = await createHarnessRegistry().probe("nope");
    expect(probe.installed).toBe(false);
    expect(probe.error).toMatch(/No harness named "nope"/);
  });

  it("ships mock, claude-code and codex", () => {
    expect(defaultHarnessRegistry().ids()).toEqual([
      "mock",
      "claude-code",
      "codex",
    ]);
  });

  /**
   * Step 42. The Desk prints these to an operator deciding what a seat may do,
   * so they are asserted against the harnesses rather than taken on trust from
   * a table in the UI.
   */
  it("has every shipped harness say what it does with a seat", () => {
    for (const harness of defaultHarnessRegistry().list()) {
      expect(
        harness.confinement,
        `${harness.id} declares no confinement`,
      ).toBeTypeOf("function");
    }
  });

  it("has codex confine every read-only seat and only those", () => {
    // The mapping the subprocess is actually launched with — `sandboxFor` is
    // what builds the `--sandbox` flag, and `confinement()` is declared from
    // it rather than restated, so this is really asserting the two cannot
    // drift apart.
    const codex = defaultHarnessRegistry().get("codex");
    expect(codex?.confinement?.("reviewer")).toBe("read-only");
    expect(codex?.confinement?.("caller")).toBe("read-only");
    expect(codex?.confinement?.("worker")).toBe("read-only");
    expect(codex?.confinement?.("engineer")).toBe("workspace-write");
  });

  it("has claude-code say plainly that it confines no seat", () => {
    // Not an oversight and not an absence: Claude Code takes no role-based
    // sandbox flag, so on that harness the leash and the daemon are the whole
    // boundary. A Desk that printed "a reviewer cannot write" for it would be
    // wrong, which is why this claim is declared rather than inferred.
    const claude = defaultHarnessRegistry().get("claude-code");
    for (const role of ["engineer", "reviewer", "caller"] as const) {
      expect(claude?.confinement?.(role)).toBe("none");
    }
  });

  it("ships two real harnesses from different vendors", () => {
    // Not bookkeeping. `distinct_vendors = 2` is an equality check over
    // `vendor`, so a stock build with one real vendor cannot satisfy the
    // README's own headline Gate. This is the assertion that fails if someone
    // unregisters `codex` or copies a vendor string between harnesses.
    const vendors = new Set(
      defaultHarnessRegistry()
        .list()
        .filter((h) => h.id !== "mock")
        .map((h) => h.vendor),
    );
    expect(vendors.size).toBeGreaterThanOrEqual(2);
  });
});
