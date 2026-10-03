/**
 * Step 62's done-when, through HTTP: the Desk's question — "what am I paying
 * for context, per run, across this project's Stations" — answered with a
 * number, and a projection that grows by 10k tokens showing up as a cost
 * change rather than a bigger file.
 *
 * Real daemon, real Commons, real projector, real run store. The one thing
 * faked is the vendor: a mock that bills a known price per input token, so the
 * rate the audit reads back out of the ledger is a number this test chose.
 */
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextAudit, HostEnv } from "@cuesheet/core";
import {
  createHarnessRegistry,
  createMockHarness,
  type Harness,
} from "@cuesheet/harness";
import { BRIEF_SOURCE_ID } from "./context.js";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";
import { createFileRunStore, type StoredRun } from "./store.js";
import { createRunIdFactory } from "./ids.js";

let home: string;
let env: HostEnv;
let cwd: string;
let workspace: string;
let daemon: DaemonHandle | null = null;

/** $3 for a million input tokens, every run — so a token is $0.000003. */
const PRICE = 3 / 1_000_000;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-ctx-")));
  env = { platform: process.platform, homedir: home };
  cwd = path.join(home, "project");
  workspace = path.join(home, "workspace");
  await mkdir(cwd, { recursive: true });
  await mkdir(workspace, { recursive: true });
  // Absolute workspaces: a relative one resolves against the daemon's
  // process directory, not the project (Step 59's recorded defect).
  await writeFile(
    path.join(cwd, "cuesheet.toml"),
    `
[[station]]
id = "hand"
harness = "mock"
role = "engineer"
workspace = ${JSON.stringify(workspace)}
paths = ["**"]
deny = [".git/**"]

[[station]]
id = "local"
harness = "fileless"
role = "worker"
workspace = ${JSON.stringify(workspace)}

[[station]]
id = "stranger"
harness = "not-in-this-build"
role = "worker"
workspace = ${JSON.stringify(workspace)}
`,
    "utf8",
  );
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  await rm(home, { recursive: true, force: true });
});

function runtime() {
  const priced: Harness = {
    ...createMockHarness({ standby: false }),
    id: "mock",
    vendor: "acme",
    async run(ctx) {
      ctx.meter.record({ tokensIn: 1_000_000, tokensOut: 0, usd: 3 });
      return { status: "done", cost: ctx.meter.total() };
    },
  };
  // A harness with no context file of its own, which is how `ollama` is
  // shaped: the daemon puts the Commons into its brief instead.
  const fileless: Harness = {
    ...createMockHarness({ standby: false }),
    id: "fileless",
    vendor: "local",
    roles: ["worker"],
    contextFiles: [],
  };
  return harnessRuntime({
    registry: createHarnessRegistry([priced, fileless]),
  });
}

async function boot(): Promise<string> {
  daemon = await startDaemon({
    port: 0,
    env,
    cwd,
    writeLockFile: false,
    store: createFileRunStore({
      root: path.join(home, "runs"),
      newId: createRunIdFactory(),
    }),
    ...runtime(),
  });
  const project = daemon.defaultProject;
  if (!project) throw new Error("the daemon bootstrapped no project");
  return `${daemon.url}/projects/${project.project.id}`;
}

async function audit(url: string): Promise<ContextAudit> {
  const response = await fetch(`${url}/context`);
  expect(response.status).toBe(200);
  return (await response.json()) as ContextAudit;
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function runOnce(url: string): Promise<void> {
  const { runId } = (await (
    await post(`${url}/runs`, { prompt: "spend something" })
  ).json()) as { runId: string };
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const response = await fetch(`${url}/runs/${runId}`);
    if (response.ok) {
      const stored = (await response.json()) as StoredRun;
      if (stored.run.finishedAt) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} never finished`);
}

describe("GET /projects/:id/context", () => {
  it("answers per run, across the project's Stations, with a number", async () => {
    const url = await boot();
    await writeFile(path.join(cwd, "MOCK.md"), "x".repeat(8_000), "utf8");

    const before = await audit(url);
    // 8,000 bytes is 2,000 tokens, loaded by the one Station whose harness
    // declares MOCK.md. Nothing has run, so nothing can be priced yet — and
    // the audit says which Station that leaves out rather than printing $0.
    expect(before.perRun.estimatedTokens).toBe(2_000);
    expect(before.perRun.usd).toBeUndefined();
    expect(before.perRun.unpriced).toEqual(["hand"]);
    expect(before.files.find((f) => f.id === "project:MOCK.md")).toMatchObject({
      exists: true,
      loadedBy: ["hand"],
      perRunTokens: 2_000,
    });
    // A harness this build does not have is unknown, not free.
    expect(
      before.stations.find((s) => s.stationId === "stranger"),
    ).toMatchObject({ known: false });

    await runOnce(url);
    const after = await audit(url);
    expect(after.rates).toEqual([{ vendor: "acme", usdPerInputToken: PRICE }]);
    expect(after.perRun.usd).toBeCloseTo(2_000 * PRICE, 12);
    expect(after.history).toMatchObject({ runs: 1, estimatedTokens: 2_000 });
  });

  it("shows a projection 10k tokens larger as a cost change, not a bigger file", async () => {
    const url = await boot();
    await runOnce(url);
    const before = await audit(url);
    expect(before.perRun.estimatedTokens).toBe(0);

    // 40,000 bytes of fact body: 10,000 estimated tokens, plus a title and
    // the markers around it. Written through the Commons, so the growth
    // arrives the way it would in use — by the projector, not by hand.
    // Tagged with the project: an untagged fact is the user layer, which
    // `mock` declares no file for.
    const written = await post(`${daemon?.url ?? ""}/commons`, {
      title: "Everything about the build",
      body: "y".repeat(40_000),
      projects: [daemon?.defaultProject?.project.id],
    });
    expect(written.status).toBe(201);
    const projected = await readFile(path.join(cwd, "MOCK.md"), "utf8");
    expect(projected).toContain("Everything about the build");

    const after = await audit(url);
    const grew = after.perRun.estimatedTokens - before.perRun.estimatedTokens;
    // At least the 10k, and every token of it priced: the priced Station's
    // share moves by its tokens at the observed rate, which is the sentence
    // the step asked for — a cost, not a size.
    const hand = (audit: ContextAudit) =>
      audit.stations.find((s) => s.stationId === "hand");
    const handGrew =
      (hand(after)?.estimatedTokens ?? 0) -
      (hand(before)?.estimatedTokens ?? 0);
    expect(handGrew).toBeGreaterThanOrEqual(10_000);
    expect(handGrew).toBeLessThan(10_100);
    expect(
      (hand(after)?.usdPerRun ?? 0) - (hand(before)?.usdPerRun ?? 0),
    ).toBeCloseTo(handGrew * PRICE, 12);
    expect(after.perRun.usd).toBeCloseTo(handGrew * PRICE, 12);

    // The file's growth is attributed to Cuesheet's own block, so the
    // operator can see it came from the Commons and not from their prose.
    const file = after.files.find((f) => f.id === "project:MOCK.md");
    expect(file?.generatedTokens).toBe(file?.estimatedTokens);

    // And the Station that has no file pays for the same fact in its
    // brief — which is why the whole crew grew by roughly twice the fact.
    const brief = after.files.find((f) => f.id === BRIEF_SOURCE_ID);
    expect(brief).toMatchObject({ kind: "brief", loadedBy: ["local"] });
    expect(brief?.estimatedTokens).toBeGreaterThanOrEqual(10_000);
    expect(grew).toBe(handGrew + (brief?.estimatedTokens ?? 0));
    expect(after.perRun.unpriced).toEqual(["local"]);
  }, 30_000);

  it("is scoped to a project", async () => {
    await boot();
    expect((await fetch(`${daemon?.url ?? ""}/context`)).status).toBe(404);
    expect(
      (await fetch(`${daemon?.url ?? ""}/projects/nope-000000/context`)).status,
    ).toBe(404);
  });
});
