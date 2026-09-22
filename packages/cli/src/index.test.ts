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
import { daemonLockFile, type HostEnv } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "@cuesheet/daemon";
import { runCli, type CliOptions } from "./index.js";

let home: string;
let projectRoot: string;
let env: HostEnv;
let daemon: DaemonHandle | null;
let output: string[];
let errors: string[];

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-cli-")));
  projectRoot = path.join(home, "project");
  await mkdir(path.join(projectRoot, "nested"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "cuesheet.toml"),
    [
      "[[station]]",
      'id = "builder"',
      'harness = "mock"',
      'role = "engineer"',
      'workspace = "."',
      'paths = ["**"]',
      'deny = [".git/**"]',
      "",
      "[cuesheet.ship]",
      'cues = [{ station = "builder", action = "implement" }]',
      "",
    ].join("\n"),
  );
  env = { platform: process.platform, homedir: home };
  daemon = null;
  output = [];
  errors = [];
});

afterEach(async () => {
  await daemon?.close();
  await rm(home, { recursive: true, force: true });
});

function cliOptions(cwd = projectRoot): CliOptions {
  return {
    cwd,
    env,
    output: (line) => output.push(line),
    error: (line) => errors.push(line),
  };
}

async function boot(): Promise<DaemonHandle> {
  daemon = await startDaemon({
    port: 0,
    cwd: home,
    env,
    writeLockFile: false,
  });
  await mkdir(path.dirname(daemonLockFile(env)), { recursive: true });
  await writeFile(
    daemonLockFile(env),
    JSON.stringify({
      pid: process.pid,
      port: daemon.port,
      version: "test",
      startedAt: new Date().toISOString(),
    }),
  );
  return daemon;
}

describe("the cuesheet CLI", () => {
  it("registers a project and queues its named cuesheet from a nested directory", async () => {
    const active = await boot();
    expect(
      await runCli(["project", "add", projectRoot], cliOptions(home)),
    ).toBe(0);
    const id = output[0]?.split("\t")[0];
    expect(id).toBeTruthy();

    output.length = 0;
    expect(
      await runCli(["stations"], cliOptions(path.join(projectRoot, "nested"))),
    ).toBe(0);
    expect(output).toContain("builder\tengineer\tmock");
    expect(output.some((line) => line.includes("cuesheet ship"))).toBe(true);

    output.length = 0;
    expect(
      await runCli(
        ["run", "--cuesheet", "ship", "Please implement the change"],
        cliOptions(path.join(projectRoot, "nested")),
      ),
    ).toBe(0);
    const runId = output[0]?.match(/^Queued (\S+)/)?.[1];
    expect(runId).toBeTruthy();
    const detail = await fetch(`${active.url}/projects/${id}/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(
      (await detail.json()) as { run: { cuesheetId: string; prompt: string } },
    ).toMatchObject({
      run: {
        cuesheetId: "ship",
        prompt: "Please implement the change",
      },
    });

    output.length = 0;
    expect(
      await runCli(
        ["show", runId ?? "", "--project", id ?? ""],
        cliOptions(home),
      ),
    ).toBe(0);
    expect(
      JSON.parse(output[0] ?? "{}") as { run: { id: string } },
    ).toMatchObject({
      run: { id: runId },
    });

    output.length = 0;
    expect(
      await runCli(["runs", "--project", id ?? ""], cliOptions(home)),
    ).toBe(0);
    expect(output.some((line) => line.startsWith(runId ?? "absent"))).toBe(
      true,
    );

    output.length = 0;
    expect(
      await runCli(
        ["stop", runId ?? "", "--project", id ?? ""],
        cliOptions(home),
      ),
    ).toBe(0);
    expect(output[0]).toContain(runId);
    expect(errors).toEqual([]);
  });

  it("reports a stale daemon and an unregistered directory clearly", async () => {
    expect(await runCli(["projects"], cliOptions())).toBe(1);
    expect(errors[0]).toMatch(/Start it with/);

    await boot();
    errors.length = 0;
    expect(await runCli(["runs"], cliOptions(projectRoot))).toBe(1);
    expect(errors[0]).toMatch(/No registered project contains/);
    expect(await readFile(daemonLockFile(env), "utf8")).toContain("port");
  });

  it("rejects unsupported flags before contacting the daemon", async () => {
    expect(
      await runCli(
        ["run", "--engineer", "builder", "Do work"],
        cliOptions(projectRoot),
      ),
    ).toBe(1);
    expect(errors[0]).toContain("Unknown option --engineer");
  });
});
