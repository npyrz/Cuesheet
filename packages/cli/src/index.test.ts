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
  it("checks updates without selecting a project", async () => {
    daemon = await startDaemon({
      port: 0,
      cwd: home,
      env,
      writeLockFile: false,
      updates: {
        status: () => ({
          phase: "available",
          mode: "source",
          currentVersion: "test",
          message: "Release available. Run npm run update.",
        }),
        check: async () => {},
        prepareInstall: () => {},
        restart: () => {},
      },
    });
    const variables = { CUESHEET_URL: daemon.url };
    expect(await runCli(["updates"], { ...cliOptions(home), variables })).toBe(
      0,
    );
    expect(output).toEqual(["Release available. Run npm run update."]);
  });

  it("prints what always-loaded context costs, and calls it an estimate", async () => {
    // A harness that declares MOCK.md, so the audit has a file to count. The
    // default `startDaemon` knows no harness, which would report the Station
    // as unknown — true, and not what this test is about.
    daemon = await startDaemon({
      port: 0,
      cwd: home,
      env,
      writeLockFile: false,
      harnessContext: () => ({
        vendor: "cuesheet",
        contextFiles: [{ path: "MOCK.md", scope: "project" }],
      }),
    });
    await writeFile(path.join(projectRoot, "MOCK.md"), "z".repeat(4_000));
    const variables = { CUESHEET_URL: daemon.url };
    expect(
      await runCli(["project", "add", projectRoot], {
        ...cliOptions(home),
        variables,
      }),
    ).toBe(0);
    output.length = 0;

    expect(
      await runCli(["context"], { ...cliOptions(projectRoot), variables }),
    ).toBe(0);
    expect(output[0]).toBe(
      "Context per run: about 1,000 tokens across 1 Station (estimated).",
    );
    // Nothing has run, so nothing is priced — said, not printed as $0.00.
    expect(output[1]).toBe(
      "Price per run: unknown — no price reported for builder.",
    );
    expect(output).toContain("MOCK.md\t1,000\t0\t1,000\tbuilder");
  });

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
    // Shown, and never without the word that says what kind of number it is.
    expect(output[0]).toMatch(/about \d+ tokens \(estimated\)/);
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

  it("rejects --check anywhere but rewind, before contacting the daemon", async () => {
    // No daemon is running: the refusal has to come from the parser.
    expect(await runCli(["runs", "--check"], cliOptions(projectRoot))).toBe(1);
    expect(errors[0]).toBe("--check only applies to rewind.");
  });

  it("passes a rewind refusal through in the daemon's words, and exits 1", async () => {
    // This daemon's default executor writes nothing and records no change,
    // which is the refusal every pre-Step-60 run also gets.
    const active = await boot();
    expect(
      await runCli(["project", "add", projectRoot], cliOptions(home)),
    ).toBe(0);
    const id = output[0]?.split("\t")[0] ?? "";
    const response = await fetch(`${active.url}/projects/${id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "nothing" }),
    });
    const { runId } = (await response.json()) as { runId: string };
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const detail = (await (
        await fetch(`${active.url}/projects/${id}/runs/${runId}`)
      ).json()) as { run: { finishedAt?: string } };
      if (detail.run.finishedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(
      await runCli(["rewind", runId, "--check"], cliOptions(projectRoot)),
    ).toBe(1);
    expect(errors.at(-1)).toContain("did not record a change of its own");
  });
});
