import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type ContextAudit, type HostEnv } from "@cuesheet/core";
import { auditContext } from "./context-audit.js";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";
import { PROJECTION_BEGIN, PROJECTION_END } from "./projections.js";

let home: string;
let root: string;
let env: HostEnv;
let daemon: DaemonHandle | undefined;
beforeEach(async () => {
  home = await realpath(
    await mkdtemp(path.join(tmpdir(), "cuesheet-context-")),
  );
  root = path.join(home, "project with spaces");
  await mkdir(root);
  env = { platform: process.platform, homedir: home };
});
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await rm(home, { recursive: true, force: true });
});
function config() {
  return parseConfig(
    `
[[station]]
id = "author"
harness = "claude-code"
role = "engineer"
workspace = ${JSON.stringify(root)}
[[station]]
id = "review"
harness = "codex"
role = "reviewer"
workspace = ${JSON.stringify(root)}
[cuesheet.ship]
cues = [{station="author",action="write"},{hook="format"},{station="review",action="review"},{gate="check"},{station="author",action="fix"}]
`,
    "test",
  ).config;
}

describe("context cost audit", () => {
  it("counts only each harness's files, includes user context, and multiplies repeated cues without writing", async () => {
    await writeFile(path.join(root, "CLAUDE.md"), "a".repeat(400));
    await writeFile(path.join(root, "AGENTS.md"), "é".repeat(200));
    await mkdir(path.join(home, ".claude"));
    await writeFile(path.join(home, ".claude", "CLAUDE.md"), "u".repeat(40));
    await writeFile(
      path.join(root, "cuesheet.toml"),
      `
[[station]]
id="author"
harness="claude-code"
role="engineer"
workspace=${JSON.stringify(root)}
[[station]]
id="review"
harness="codex"
role="reviewer"
workspace=${JSON.stringify(root)}
[cuesheet.ship]
cues=[{station="author",action="write"},{station="review",action="review"},{station="author",action="fix"}]
`,
    );
    const before = await readFile(path.join(root, "CLAUDE.md"));
    daemon = await startDaemon({
      port: 0,
      env,
      cwd: home,
      writeLockFile: false,
      harnessContextFiles: harnessRuntime().harnessContextFiles,
    });
    const { project } = (await (
      await fetch(`${daemon.url}/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root }),
      })
    ).json()) as { project: { id: string } };
    const url = `${daemon.url}/projects/${project.id}/context-audit`;
    const response = await fetch(`${url}?runs=3`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as ContextAudit;
    expect(result.complete).toBe(true);
    expect(result.stations.map((station) => station.estimatedTokens)).toEqual([
      110, 100,
    ]);
    expect(result.estimatedTokensAcrossStations).toBe(210);
    expect(result.plans).toEqual([
      {
        cuesheet: null,
        stationIds: ["author"],
        estimatedTokensPerRun: 110,
        estimatedTokens: 330,
        complete: true,
      },
      {
        cuesheet: "ship",
        stationIds: ["author", "review", "author"],
        estimatedTokensPerRun: 320,
        estimatedTokens: 960,
        complete: true,
      },
    ]);
    expect(
      result.files.find((file) =>
        file.path.endsWith(path.join(".codex", "AGENTS.md")),
      )?.state,
    ).toBe("missing");
    expect(await readFile(path.join(root, "CLAUDE.md"))).toEqual(before);
    for (const runs of ["0", "-1", "1.5", "wat", "1000001", "", "1e2"]) {
      expect((await fetch(`${url}?runs=${runs}`)).status).toBe(400);
    }
    expect(
      (await fetch(`${daemon.url}/api/projects/${project.id}/context-audit`))
        .status,
    ).toBe(200);
    expect(
      (await fetch(`${daemon.url}/projects/missing-000000/context-audit`))
        .status,
    ).toBe(404);
  });

  it("a 10k-token projection growth adds 20k per repeated run and 60k across three runs", async () => {
    const runtime = harnessRuntime();
    const file = path.join(root, "CLAUDE.md");
    const text = (body: string) =>
      `operator\n${PROJECTION_BEGIN}\n${body}\n${PROJECTION_END}\n`;
    await writeFile(file, text(""));
    const options = {
      config: config(),
      env,
      filesOf: runtime.harnessContextFiles,
      runs: 3,
    };
    const before = await auditContext(options);
    await writeFile(file, text("x".repeat(40_000)));
    const after = await auditContext(options);
    expect(
      after.files.find((row) => row.path === file)!.projectionEstimatedTokens! -
        before.files.find((row) => row.path === file)!
          .projectionEstimatedTokens!,
    ).toBe(10_000);
    expect(
      after.plans[1]!.estimatedTokensPerRun -
        before.plans[1]!.estimatedTokensPerRun,
    ).toBe(20_000);
    expect(
      after.plans[1]!.estimatedTokens - before.plans[1]!.estimatedTokens,
    ).toBe(60_000);
    expect(await auditContext(options)).toEqual(after);
  });

  it("deduplicates shared files while counting every consuming Station", async () => {
    const loaded = config();
    loaded.station[1]!.harness = "claude-code";
    await writeFile(path.join(root, "CLAUDE.md"), "a".repeat(400));
    const result = await auditContext({
      config: loaded,
      env,
      filesOf: () => [
        { path: "CLAUDE.md", scope: "project" },
        { path: "CLAUDE.md", scope: "project" },
      ],
      runs: 1,
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.stationIds).toEqual(["author", "review"]);
    expect(result.estimatedTokensAcrossStations).toBe(200);
    expect(result.plans[1]!.estimatedTokensPerRun).toBe(300);
  });

  it("distinguishes no context, missing files, unreadable files and unknown harness declarations", async () => {
    const loaded = config();
    const options = { config: loaded, env, runs: 1 };
    expect(
      (await auditContext({ ...options, filesOf: () => [] })).complete,
    ).toBe(true);
    const unknown = await auditContext({
      ...options,
      filesOf: () => undefined,
    });
    expect(unknown.complete).toBe(false);
    expect(unknown.stations[0]!.reason).toContain("unknown");
    await mkdir(path.join(root, "CLAUDE.md"));
    const unreadable = await auditContext({
      ...options,
      filesOf: () => [{ path: "CLAUDE.md", scope: "project" }],
    });
    expect(unreadable.files[0]).toMatchObject({
      state: "unreadable",
      estimatedTokens: null,
    });
    expect(unreadable.plans[1]!.complete).toBe(false);
    const unsafe = await auditContext({
      ...options,
      filesOf: () => [{ path: "../secret", scope: "project" }],
    });
    expect(unsafe.files).toHaveLength(0);
    expect(unsafe.complete).toBe(false);
  });
});
