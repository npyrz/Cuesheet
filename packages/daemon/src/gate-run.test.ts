/**
 * Gates, end to end: HTTP into the queue, through two Stations from two
 * vendors, into a Gate that either lets the work through or holds it.
 *
 * The unit tests in `core/gate.test.ts` prove the arithmetic. These prove the
 * wiring — that a reviewer is actually asked to review, that its prose becomes
 * a verdict, that a held run raises a standby and lands as `held`, and that
 * none of it depends on a model being installed.
 */
import { mkdtemp, writeFile, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockHarness,
  createHarnessRegistry,
  type Harness,
  type MockHarnessOptions,
} from "@cuesheet/harness";
import type { HostEnv, RunEvent, Verdict } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";
import { createFileRunStore, type StoredRun } from "./store.js";
import { createRunIdFactory } from "./ids.js";

const exec = promisify(execFile);

// Each test boots a daemon and runs several real `git` processes per cue.
// That is 1–2 s alone and, measured on a Windows machine with the whole suite
// running in parallel, past vitest's 5 s default — `HEAD` failed the same
// tests the same way before Step 58 or 59 existed. A budget, not a wait: every
// wait in this file is still on a condition. The same figure `commons.test.ts`
// and `profiles.test.ts` use for the same reason.
vi.setConfig({ testTimeout: 30_000 });

let env: HostEnv;
let cwd: string;
let root: string;
let workspace: string;
let daemon: DaemonHandle | null = null;

beforeEach(async () => {
  const home = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-gate-")),
  );
  env = { platform: process.platform, homedir: home };
  cwd = path.join(home, "project");
  workspace = path.join(home, "workspace");
  root = path.join(home, "runs");
  await mkdir(cwd, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // A real repo, because `skip_if_diff_under` and the reviewer's brief both
  // read an actual `git diff`.
  await exec("git", ["init", "-q"], { cwd: workspace });
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

/**
 * Two vendors, which is the whole point. `mock` plays the engineer and
 * `mock-two` the reviewer, with a different `vendor` string — the cheapest
 * possible stand-in for "Anthropic wrote it, OpenAI checked it".
 */
function twoVendorRuntime(review: MockHarnessOptions["review"] = "pass") {
  const engineer: Harness = {
    ...createMockHarness({ standby: false }),
    id: "mock",
    vendor: "cuesheet",
  };
  const reviewer: Harness = {
    ...createMockHarness({ standby: false, review }),
    id: "mock-two",
    vendor: "other-vendor",
  };
  return harnessRuntime({
    registry: createHarnessRegistry([engineer, reviewer]),
  });
}

/** One vendor doing both jobs — the case a Gate exists to catch. */
function oneVendorRuntime() {
  const engineer: Harness = {
    ...createMockHarness({ standby: false }),
    id: "mock",
    vendor: "cuesheet",
  };
  const reviewer: Harness = {
    ...createMockHarness({ standby: false, review: "pass" }),
    id: "mock-two",
    vendor: "cuesheet",
  };
  return harnessRuntime({
    registry: createHarnessRegistry([engineer, reviewer]),
  });
}

async function writeConfig(gate: string): Promise<void> {
  await writeFile(
    path.join(cwd, "cuesheet.toml"),
    `
[[station]]
id = "maker"
harness = "mock"
role = "engineer"
workspace = ${JSON.stringify(workspace)}
paths = ["**"]
deny = [".git/**"]

[[station]]
id = "checker"
harness = "mock-two"
role = "reviewer"
workspace = ${JSON.stringify(workspace)}
paths = ["**"]
deny = [".git/**"]

${gate}

[cuesheet.ship]
cues = [
  { station = "maker", action = "implement" },
  { station = "checker", action = "review" },
  { gate = "default" },
]
`,
    "utf8",
  );
}

async function boot(runtime = twoVendorRuntime()): Promise<DaemonHandle> {
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

/**
 * Where this file's single project's routes hang off.
 *
 * One project per test here, bootstrapped from the `cuesheet.toml` written
 * into `cwd` — so "the project" is unambiguous, which it deliberately is not
 * in the HTTP API itself.
 */
function projectBase(): string {
  if (!daemon) throw new Error("no daemon is running");
  const runtime = daemon.defaultProject;
  if (!runtime) throw new Error("the daemon bootstrapped no project");
  return `${daemon.url}/projects/${runtime.project.id}`;
}

async function bootProject(runtime = twoVendorRuntime()): Promise<string> {
  await boot(runtime);
  return projectBase();
}

async function runShip(url: string): Promise<string> {
  const response = await fetch(`${url}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "add rate limiting", cuesheet: "ship" }),
  });
  const { runId } = (await response.json()) as { runId: string };
  return runId;
}

async function waitForRun(url: string, runId: string): Promise<StoredRun> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${url}/runs/${runId}`);
    if (response.ok) {
      const stored = (await response.json()) as StoredRun;
      if (stored.run.finishedAt) return stored;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} never finished`);
}

/** Answer the first standby the run raises. */
async function answerStandby(
  url: string,
  runId: string,
  answer: "go" | "no",
): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${url}/runs/${runId}`);
    if (response.ok) {
      const stored = (await response.json()) as StoredRun;
      const standby = stored.events.find(
        (event: RunEvent) => event.t === "standby",
      );
      if (standby !== undefined && standby.t === "standby") {
        await fetch(`${daemon!.url}/standbys/${standby.standbyId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer }),
        });
        return standby.ask;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} never raised a standby`);
}

describe("a gated cuesheet", () => {
  it("passes when a second vendor approves", async () => {
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2',
    );
    const url = await bootProject();
    const stored = await waitForRun(url, await runShip(url));

    expect(stored.run.status).toBe("done");
    expect(stored.run.result?.gates).toEqual([
      { gate: "default", outcome: "pass", reasons: [] },
    ]);

    // The reviewer's prose was read as a verdict, and the verdict names who
    // gave it — which is what `distinct_vendors` is counted over.
    const verdicts = stored.run.result?.verdicts ?? [];
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      stationId: "checker",
      vendor: "other-vendor",
      decision: "pass",
    });
  });

  it("holds, asks, and lands as `held` when the answer is no", async () => {
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2\nblocking = ["correctness"]',
    );
    const url = await bootProject(twoVendorRuntime("fail"));
    const runId = await runShip(url);

    const ask = await answerStandby(url, runId, "no");
    expect(ask).toContain('Gate "default" held this run');
    expect(ask).toContain("blocking finding");

    const stored = await waitForRun(url, runId);
    expect(stored.run.status).toBe("held");
    expect(stored.run.result?.gates?.[0]).toMatchObject({
      gate: "default",
      outcome: "hold",
    });
    expect(stored.run.result?.gates?.[0]?.overridden).toBeUndefined();
  });

  it("continues when a human overrides the hold", async () => {
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2\nblocking = ["correctness"]',
    );
    const url = await bootProject(twoVendorRuntime("fail"));
    const runId = await runShip(url);

    await answerStandby(url, runId, "go");

    const stored = await waitForRun(url, runId);
    expect(stored.run.status).toBe("done");
    expect(stored.run.result?.gates?.[0]).toMatchObject({
      outcome: "hold",
      overridden: true,
    });
  });

  it("holds when the reviewer shares the author's vendor", async () => {
    // The thesis, over HTTP: a passing review from the same company is not a
    // second opinion, and the gate says so without anyone configuring a rule
    // beyond `distinct_vendors = 2`.
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2',
    );
    const url = await bootProject(oneVendorRuntime());
    const runId = await runShip(url);

    const ask = await answerStandby(url, runId, "no");
    expect(ask).toContain("1 vendor");

    expect((await waitForRun(url, runId)).run.status).toBe("held");
  });

  it("holds a reviewer that said nothing parseable", async () => {
    // The test that decides whether this is a safety feature: silence is an
    // abstention, and an abstention cannot satisfy `require`.
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2',
    );
    const url = await bootProject(twoVendorRuntime("silent"));
    const runId = await runShip(url);

    const ask = await answerStandby(url, runId, "no");
    expect(ask).toContain("0 of 1 required approval");

    const stored = await waitForRun(url, runId);
    expect(stored.run.status).toBe("held");
    expect(stored.run.result?.verdicts?.[0]?.decision).toBe("abstain");
  });

  it("holds on a blocking finding the reviewer itself waved through", async () => {
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2\nblocking = ["security"]',
    );
    const url = await bootProject(twoVendorRuntime("blocking"));
    const runId = await runShip(url);

    const ask = await answerStandby(url, runId, "no");
    expect(ask).toContain("blocking finding");
    expect((await waitForRun(url, runId)).run.status).toBe("held");
  });

  it("emits each verdict on the wire as it is reached", async () => {
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2',
    );
    const url = await bootProject();
    const stored = await waitForRun(url, await runShip(url));

    const verdicts = stored.events.filter(
      (event: RunEvent) => event.t === "verdict",
    );
    expect(verdicts).toHaveLength(1);
    const [event] = verdicts;
    expect(event?.t === "verdict" && event.verdict.decision).toBe("pass");
  });

  it("gives the reviewer the diff and the review instructions, not the original brief", async () => {
    // Without this a "reviewer" just does the task again with another model:
    // it looks like a review, costs like a review, and checks nothing.
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2',
    );
    const url = await bootProject();
    const stored = await waitForRun(url, await runShip(url));

    const briefLine = stored.events.find(
      (event: RunEvent) =>
        event.t === "text" &&
        event.stationId === "checker" &&
        event.chunk.includes("Reading the diff"),
    );
    expect(briefLine).toBeDefined();

    // The engineer, by contrast, was given the actual brief.
    const engineerLine = stored.events.find(
      (event: RunEvent) =>
        event.t === "text" &&
        event.stationId === "maker" &&
        event.chunk.includes("add rate limiting"),
    );
    expect(engineerLine).toBeDefined();
  });

  it("skips the gate entirely for a change too small to review", async () => {
    await writeConfig(
      '[gate.default]\nrequire = "2-of-2"\ndistinct_vendors = 9\nskip_if_diff_under = 10000',
    );
    const url = await bootProject(twoVendorRuntime("silent"));
    const stored = await waitForRun(url, await runShip(url));

    // Nothing could have satisfied that gate. The diff was small, so it never
    // asked.
    expect(stored.run.status).toBe("done");
    expect(stored.run.result?.gates?.[0]?.outcome).toBe("skipped");
  });

  it("fails the run when a cue names a gate that is not configured", async () => {
    // "The check did not run" must never look like "the check passed".
    await writeConfig('[gate.other]\nrequire = "1-of-1"');
    const url = await bootProject();
    const stored = await waitForRun(url, await runShip(url));

    expect(stored.run.status).toBe("failed");
    expect(stored.run.error).toContain('gate "default"');
  });

  it("takes verdicts a harness reports directly, without parsing prose", async () => {
    // The other half of `collectVerdicts`: a harness that understands verdicts
    // returns them, and the executor stamps them with who gave them.
    const reported: Verdict[] = [
      {
        id: "",
        runId: "",
        stationId: "",
        harness: "",
        vendor: "",
        decision: "pass",
        findings: [],
        at: "",
      },
    ];
    const reviewer: Harness = {
      ...createMockHarness({ standby: false }),
      id: "mock-two",
      vendor: "other-vendor",
      async run() {
        return { status: "done", verdicts: reported };
      },
    };
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2',
    );
    const url = await bootProject(
      harnessRuntime({
        registry: createHarnessRegistry([
          { ...createMockHarness({ standby: false }), id: "mock" },
          reviewer,
        ]),
      }),
    );

    const stored = await waitForRun(url, await runShip(url));
    expect(stored.run.status).toBe("done");
    expect(stored.run.result?.verdicts?.[0]).toMatchObject({
      stationId: "checker",
      harness: "mock-two",
      vendor: "other-vendor",
      decision: "pass",
    });
  });
});

/**
 * Step 58 — the brief has a budget.
 *
 * Each test reads the brief a reviewer was actually handed, which is the only
 * way to prove what a second vendor would have been billed for.
 */
describe("the brief budget", () => {
  /** A reviewer that records every brief it is given, and passes. */
  function recordingReviewer(briefs: string[]): Harness {
    return {
      ...createMockHarness({ standby: false }),
      id: "mock-two",
      vendor: "other-vendor",
      async run(ctx) {
        briefs.push(ctx.brief);
        return {
          status: "done",
          verdicts: [
            {
              id: "",
              runId: "",
              stationId: "",
              harness: "",
              vendor: "",
              decision: "pass",
              findings: [],
              at: "",
            },
          ],
        };
      },
    };
  }

  /** An engineer that changes nothing, so the workspace's diff is the test's. */
  const idleEngineer: Harness = {
    ...createMockHarness({ standby: false }),
    id: "mock",
    vendor: "cuesheet",
    async run() {
      return { status: "done" };
    },
  };

  function lockfile(lines: number): string {
    return Array.from(
      { length: lines },
      (_, i) => `    "node_modules/pkg-${i}": { "version": "1.0.${i}" },`,
    ).join("\n");
  }

  it("sends a bounded brief over a 40k-line diff, and says what it left out", async () => {
    await writeFile(
      path.join(workspace, "package-lock.json"),
      lockfile(40_000),
      "utf8",
    );
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2\n\n[limits]\nmax_brief_bytes = 60000',
    );
    const briefs: string[] = [];
    const url = await bootProject(
      harnessRuntime({
        registry: createHarnessRegistry([
          { ...createMockHarness({ standby: false }), id: "mock" },
          recordingReviewer(briefs),
        ]),
      }),
    );

    const stored = await waitForRun(url, await runShip(url));
    expect(stored.run.status).toBe("done");

    const [brief] = briefs;
    expect(brief).toBeDefined();
    expect(Buffer.byteLength(brief ?? "", "utf8")).toBeLessThanOrEqual(60_000);
    // The engineer's own change made it in whole; the lockfile is named, not
    // shown.
    expect(brief).toContain("cuesheet-mock.md");
    expect(brief).toContain("- package-lock.json (");
    expect(brief).not.toContain("pkg-39999");
    // And the record says the verdict was over less than the whole change.
    expect(stored.run.result?.gates?.[0]).toMatchObject({
      outcome: "pass",
      elided: ["package-lock.json"],
    });
  });

  it("skips a lockfile-only change on a path rule, before the reviewer is paid", async () => {
    await writeFile(
      path.join(workspace, "package-lock.json"),
      lockfile(500),
      "utf8",
    );
    // Unsatisfiable on purpose: if this gate evaluated rather than skipped,
    // the run would hold. And no `skip_if_diff_under` — only the path rule
    // can let it through.
    await writeConfig(
      '[gate.default]\nrequire = "2-of-2"\ndistinct_vendors = 9\nnever_review = ["**/package-lock.json"]',
    );
    const briefs: string[] = [];
    const url = await bootProject(
      harnessRuntime({
        registry: createHarnessRegistry([
          idleEngineer,
          recordingReviewer(briefs),
        ]),
      }),
    );

    const stored = await waitForRun(url, await runShip(url));
    expect(stored.run.status).toBe("done");
    expect(stored.run.result?.gates?.[0]?.outcome).toBe("skipped");
    expect(stored.run.result?.gates?.[0]?.reasons[0]).toContain("never_review");
    // The point of moving the decision: the reviewer never ran, so it never
    // cost anything.
    expect(briefs).toEqual([]);
    expect(
      stored.run.result?.stations?.some((s) => s.stationId === "checker"),
    ).toBe(false);
  });

  it("reviews a tiny change to an always_review path that the line count would skip", async () => {
    await mkdir(path.join(workspace, "src", "auth"), { recursive: true });
    await writeFile(
      path.join(workspace, "src", "auth", "session.ts"),
      "export const ttl = 0;\n",
      "utf8",
    );
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\ndistinct_vendors = 2\nskip_if_diff_under = 10000\nalways_review = ["src/auth/**"]',
    );
    const briefs: string[] = [];
    const url = await bootProject(
      harnessRuntime({
        registry: createHarnessRegistry([
          idleEngineer,
          recordingReviewer(briefs),
        ]),
      }),
    );

    const stored = await waitForRun(url, await runShip(url));
    expect(briefs).toHaveLength(1);
    expect(briefs[0]).toContain("src/auth/session.ts");
    expect(stored.run.result?.gates?.[0]?.outcome).toBe("pass");
  });

  it("refuses an over-budget prompt at POST, before anything is queued", async () => {
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\n\n[limits]\nmax_brief_bytes = 1024',
    );
    const url = await bootProject();

    const response = await fetch(`${url}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(2_000), cuesheet: "ship" }),
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as {
      error: string;
      brief: { estimatedTokens: number };
    };
    expect(body.error).toContain("estimated");
    expect(body.brief.estimatedTokens).toBe(500);

    const listed = (await (await fetch(`${url}/runs`)).json()) as {
      runs: unknown[];
    };
    expect(listed.runs).toEqual([]);
  });

  it("refuses a reviewer whose brief cannot fit, without calling it", async () => {
    // The prompt fits an engineer's brief; wrapped in the review contract it
    // does not, and no amount of eliding the diff makes room.
    await writeConfig(
      '[gate.default]\nrequire = "1-of-1"\n\n[limits]\nmax_brief_bytes = 1024',
    );
    const briefs: string[] = [];
    const url = await bootProject(
      harnessRuntime({
        registry: createHarnessRegistry([
          idleEngineer,
          recordingReviewer(briefs),
        ]),
      }),
    );

    const response = await fetch(`${url}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "y".repeat(800), cuesheet: "ship" }),
    });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    const stored = await waitForRun(url, runId);

    expect(stored.run.status).toBe("failed");
    expect(stored.run.error).toContain("Nothing was sent");
    expect(stored.run.error).toContain("checker");
    expect(briefs).toEqual([]);
  });
});
