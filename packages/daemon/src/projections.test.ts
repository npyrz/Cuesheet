import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProjectRegistry,
  type HostEnv,
  type Project,
} from "@cuesheet/core";
import type { ContextFile } from "@cuesheet/harness";
import { createCommonsStore, type CommonsStore } from "./commons.js";
import {
  createCommonsProjector,
  mergeProjection,
  ProjectionError,
  PROJECTION_BEGIN,
  PROJECTION_END,
  renderProjection,
} from "./projections.js";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";

const files: readonly ContextFile[] = [
  { path: "CLAUDE.md", scope: "project" },
  { path: "AGENTS.md", scope: "project" },
  { path: ".claude/CLAUDE.md", scope: "user" },
  { path: ".codex/AGENTS.md", scope: "user" },
];

let home: string;
let env: HostEnv;
let store: CommonsStore;
let registry: ReturnType<typeof createProjectRegistry>;
let one: Project;
let two: Project;
let daemon: DaemonHandle | null;

beforeEach(async () => {
  home = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-projection-")),
  );
  env = { platform: process.platform, homedir: home };
  const oneRoot = path.join(home, "one");
  const twoRoot = path.join(home, "two");
  await Promise.all([mkdir(oneRoot), mkdir(twoRoot)]);
  registry = createProjectRegistry({ env });
  one = await registry.open(oneRoot);
  two = await registry.open(twoRoot);
  store = createCommonsStore({
    root: path.join(home, ".cuesheet", "commons"),
    // Projection tests do not need history, and must not depend on a machine's
    // git installation. This is the failure shape Step 46 deliberately keeps.
    gitBin: path.join(home, "missing-git"),
    now: () => new Date("2026-09-18T12:00:00.000Z"),
  });
  daemon = null;
});

afterEach(async () => {
  await daemon?.close();
  await rm(home, { recursive: true, force: true });
});

function projector() {
  return createCommonsProjector({
    store,
    registry,
    env,
    contextFiles: () => files,
  });
}

describe("Commons projections", () => {
  it("writes one project fact into both harness files and nowhere else", async () => {
    await store.write({
      id: "one-rule",
      title: "One rule",
      body: "Keep the boundary explicit.",
      projects: [one.id],
    });

    await projector().regenerate();

    const claude = await readFile(path.join(one.root, "CLAUDE.md"), "utf8");
    const codex = await readFile(path.join(one.root, "AGENTS.md"), "utf8");
    expect(claude).toBe(codex);
    expect(claude).toContain("## One rule\n\nKeep the boundary explicit.");
    await expect(access(path.join(two.root, "CLAUDE.md"))).rejects.toThrow();
    await expect(
      access(path.join(home, ".claude", "CLAUDE.md")),
    ).rejects.toThrow();
    await expect(
      access(path.join(home, ".codex", "AGENTS.md")),
    ).rejects.toThrow();
  });

  it("renders user facts once per machine, never into a project", async () => {
    await store.write({
      id: "crew-rule",
      title: "Crew rule",
      body: "Explain why, not what.",
    });

    await projector().regenerate();

    const claude = await readFile(
      path.join(home, ".claude", "CLAUDE.md"),
      "utf8",
    );
    const codex = await readFile(
      path.join(home, ".codex", "AGENTS.md"),
      "utf8",
    );
    expect(claude).toBe(codex);
    expect(claude).toContain("Explain why, not what.");
    await expect(access(path.join(one.root, "CLAUDE.md"))).rejects.toThrow();
  });

  it("preserves handwritten bytes outside the markers", async () => {
    const target = path.join(one.root, "CLAUDE.md");
    const handwritten = "# Project notes\n\nDo not remove this.  \n";
    await writeFile(target, handwritten, "utf8");
    await store.write({
      id: "generated",
      title: "Generated",
      body: "Shared memory.",
      projects: [one.id],
    });

    await projector().regenerate();
    const first = await readFile(target, "utf8");
    expect(first.startsWith(handwritten)).toBe(true);
    expect(first).toContain(PROJECTION_BEGIN);
    expect(first).toContain(PROJECTION_END);

    await store.write({
      id: "generated",
      title: "Generated",
      body: "Updated memory.",
      projects: [one.id],
    });
    await projector().regenerate();
    const second = await readFile(target, "utf8");
    expect(second.startsWith(handwritten)).toBe(true);
    expect(second).not.toContain("Shared memory.");
    expect(second.match(/cuesheet:begin/g)).toHaveLength(1);
  });

  it("is byte-stable and skips writes when nothing changed", async () => {
    await store.write({
      id: "stable",
      title: "Stable",
      body: "Same input, same bytes.",
      projects: [one.id],
    });
    const p = projector();
    const first = await p.regenerate();
    const before = await readFile(path.join(one.root, "CLAUDE.md"), "utf8");
    const second = await p.regenerate();
    const after = await readFile(path.join(one.root, "CLAUDE.md"), "utf8");

    expect(first.written).toHaveLength(2);
    expect(second.written).toEqual([]);
    expect(second.unchanged).toHaveLength(2);
    expect(after).toBe(before);
  });

  it("refuses incomplete markers and context paths outside their root", async () => {
    expect(() =>
      mergeProjection(`handwritten\n${PROJECTION_BEGIN}\n`, "replacement"),
    ).toThrow(ProjectionError);

    await store.write({
      id: "escape",
      title: "Escape",
      body: "No arbitrary writes.",
      projects: [one.id],
    });
    const unsafe = createCommonsProjector({
      store,
      registry,
      env,
      contextFiles: () => [{ path: "../outside.md", scope: "project" }],
    });
    await expect(unsafe.regenerate()).rejects.toThrow(ProjectionError);
  });

  it("orders facts by id rather than filesystem or write order", () => {
    const block = renderProjection([
      {
        id: "z-last",
        title: "Last",
        body: "z",
        tags: [],
        projects: [],
        provenance: { at: "" },
      },
      {
        id: "a-first",
        title: "First",
        body: "a",
        tags: [],
        projects: [],
        provenance: { at: "" },
      },
    ]);
    expect(block.indexOf("## First")).toBeLessThan(block.indexOf("## Last"));
  });

  it("escapes marker text inside a fact", () => {
    const block = renderProjection([
      {
        id: "marker-fact",
        title: "Marker fact",
        body: `Document ${PROJECTION_BEGIN} and ${PROJECTION_END}.`,
        tags: [],
        projects: [],
        provenance: { at: "" },
      },
    ]);
    expect(block.match(/<!-- cuesheet:begin -->/g)).toHaveLength(1);
    expect(block.match(/<!-- cuesheet:end -->/g)).toHaveLength(1);
    expect(block).toContain("&lt;!-- cuesheet:begin --&gt;");
  });

  it("takes production targets from the harness registry", () => {
    expect(harnessRuntime().contextFiles()).toEqual(
      expect.arrayContaining([
        { path: "CLAUDE.md", scope: "project" },
        { path: "AGENTS.md", scope: "project" },
        { path: ".claude/CLAUDE.md", scope: "user" },
        { path: ".codex/AGENTS.md", scope: "user" },
      ]),
    );
  });
});

describe("projection lifecycle", () => {
  it("regenerates through the API after a fact changes", async () => {
    daemon = await startDaemon({
      port: 0,
      env,
      cwd: home,
      writeLockFile: false,
      projectRegistry: registry,
      commons: store,
      contextFiles: () => files,
    });

    const response = await fetch(`${daemon.url}/commons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "api-fact",
        title: "API fact",
        body: "Projected immediately.",
        projects: [one.id],
      }),
    });
    expect(response.status).toBe(201);
    expect(await readFile(path.join(one.root, "CLAUDE.md"), "utf8")).toContain(
      "Projected immediately.",
    );

    expect(
      (await fetch(`${daemon.url}/commons/api-fact`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(
      await readFile(path.join(one.root, "CLAUDE.md"), "utf8"),
    ).not.toContain("Projected immediately.");
  });
});

/**
 * Step 59 — the repo map rides in the projection block.
 *
 * Real grammars, a real daemon, and a run started over HTTP: the map is only
 * worth anything if it is already in the context file when the agent opens it.
 */
describe("the repo map in the projection", () => {
  // Two real runs through a daemon plus `git` and the grammars: about 2.4 s
  // alone, so the default 5 s is not a budget it can keep under a parallel
  // suite. Every wait inside is still on a condition.
  vi.setConfig({ testTimeout: 30_000 });

  async function mapRuntime() {
    const { createMockHarness, createHarnessRegistry } =
      await import("@cuesheet/harness");
    return harnessRuntime({
      registry: createHarnessRegistry([createMockHarness({ standby: false })]),
    });
  }

  async function configure(root: string, mode: "projection" | "off") {
    await writeFile(
      path.join(root, "cuesheet.toml"),
      [
        "[[station]]",
        'id = "maker"',
        'harness = "mock"',
        'role = "engineer"',
        // Absolute, never ".". A relative workspace resolves against the
        // daemon's process directory, not the project root — the first draft
        // of this test said "." and the mock engineer wrote into the Cuesheet
        // checkout running the suite.
        `workspace = ${JSON.stringify(root)}`,
        'paths = ["**"]',
        'deny = ["CLAUDE.md", "AGENTS.md"]',
        "",
        "[repo_map]",
        `mode = "${mode}"`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async function runAndWait(base: string): Promise<void> {
    const response = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "touch something" }),
    });
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const detail = await fetch(`${base}/runs/${runId}`);
      const stored = (await detail.json()) as { run: { finishedAt?: string } };
      if (stored.run.finishedAt) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Run ${runId} never finished`);
  }

  it("projects the map for a project that asked, refreshes it at run start, and is byte-stable", async () => {
    await configure(one.root, "projection");
    await configure(two.root, "off");
    await mkdir(path.join(one.root, "src"));
    await writeFile(
      path.join(one.root, "src", "limiter.ts"),
      "export function limit() {}\n",
      "utf8",
    );
    await writeFile(
      path.join(two.root, "unmapped.ts"),
      "export const nope = 1;\n",
      "utf8",
    );

    daemon = await startDaemon({
      port: 0,
      env,
      cwd: home,
      writeLockFile: false,
      projectRegistry: registry,
      commons: store,
      ...(await mapRuntime()),
      contextFiles: () => files,
    });

    // Boot regeneration already wrote it: a map creates the file, because the
    // project asked for one.
    const claude = path.join(one.root, "CLAUDE.md");
    const atBoot = await readFile(claude, "utf8");
    expect(atBoot).toContain("## Repo map");
    expect(atBoot).toContain("  - limiter.ts: fn limit");
    expect(atBoot).toBe(
      await readFile(path.join(one.root, "AGENTS.md"), "utf8"),
    );
    // A project with the map off gets no file at all — no facts, no map.
    await expect(access(path.join(two.root, "CLAUDE.md"))).rejects.toThrow();

    // Changed between runs; picked up when the next run starts.
    await writeFile(
      path.join(one.root, "src", "window.ts"),
      "export class SlidingWindow {}\n",
      "utf8",
    );
    const base = `${daemon.url}/projects/${one.id}`;
    await runAndWait(base);
    const afterRun = await readFile(claude, "utf8");
    expect(afterRun).toContain("  - window.ts: class SlidingWindow");

    // Nothing about the shape changed (the mock writes Markdown, which is not
    // mapped), so a second regeneration must produce the same bytes.
    await runAndWait(base);
    expect(await readFile(claude, "utf8")).toBe(afterRun);
  });

  it("serves the map over HTTP even while the mode is off, with an estimate", async () => {
    await configure(one.root, "off");
    await writeFile(
      path.join(one.root, "api.ts"),
      "export interface Api {}\n",
      "utf8",
    );
    daemon = await startDaemon({
      port: 0,
      env,
      cwd: home,
      writeLockFile: false,
      projectRegistry: registry,
      commons: store,
      contextFiles: () => files,
    });

    const response = await fetch(`${daemon.url}/projects/${one.id}/repo-map`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mode: string;
      text: string;
      bytes: number;
      estimatedTokens: number;
      omitted: number;
    };
    expect(body.mode).toBe("off");
    expect(body.text).toContain("  - api.ts: interface Api");
    expect(body.estimatedTokens).toBe(Math.ceil(body.bytes / 4));
    expect(body.omitted).toBe(0);
    // Off means off: answering the question wrote nothing.
    await expect(access(path.join(one.root, "CLAUDE.md"))).rejects.toThrow();
  });
});
