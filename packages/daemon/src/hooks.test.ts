/**
 * Hook cues, end to end — Step 61.
 *
 * The formatter here is a real program in a real process: a small Node
 * script, run through `process.execPath` so the test does not depend on what
 * is on PATH. It reads the hook's stdin, logs it, and rewrites every `.txt`
 * file in the workspace to upper case — a formatter whose effect is visible.
 */
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHarnessRegistry,
  createMockHarness,
  type Harness,
} from "@cuesheet/harness";
import type { HookReport, HostEnv, RunResultSummary } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";
import type { RunDetailResponse } from "./store.js";

const exec = promisify(execFile);

// Real git and real processes per cue, as in `rewind.test.ts`.
vi.setConfig({ testTimeout: 30_000 });

let env: HostEnv;
let home: string;
let workspace: string;
let formatter: string;
let log: string;
let daemon: DaemonHandle | null = null;

beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), "cuesheet-hooks-")));
  env = { platform: process.platform, homedir: home };
  workspace = path.join(home, "project");
  await mkdir(workspace);
  await exec("git", ["init", "-q"], { cwd: workspace });
  log = path.join(home, "hook-log.jsonl");
  formatter = path.join(home, "format.mjs");
  await writeFile(
    formatter,
    [
      'import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";',
      'const input = JSON.parse(readFileSync(0, "utf8"));',
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify({ input, env: { run: process.env.CUESHEET_RUN_ID, after: process.env.CUESHEET_AFTER } }) + "\\n");`,
      'for (const name of readdirSync(".")) {',
      '  if (!name.endsWith(".txt")) continue;',
      '  writeFileSync(name, readFileSync(name, "utf8").toUpperCase());',
      "}",
      'console.log("formatted");',
    ].join("\n"),
    "utf8",
  );
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

/** An engineer from `vendor` that writes one lower-case file. */
function engineer(id: string, vendor: string, file: string): Harness {
  return {
    ...createMockHarness({ standby: false }),
    id,
    vendor,
    async run(ctx) {
      await ctx.workspace.write(file, `written by ${vendor}\n`);
      return { status: "done" };
    },
  };
}

async function boot(hooks: string, cues: string): Promise<string> {
  await writeFile(
    path.join(workspace, "cuesheet.toml"),
    [
      ...["a", "b"].flatMap((id) => [
        "[[station]]",
        `id = "eng-${id}"`,
        `harness = "vendor-${id}"`,
        'role = "engineer"',
        `workspace = ${JSON.stringify(workspace)}`,
        'paths = ["**"]',
        'deny = [".git/**", "cuesheet.toml"]',
        "",
      ]),
      hooks,
      "",
      "[cuesheet.ship]",
      `cues = [${cues}]`,
      "",
    ].join("\n"),
    "utf8",
  );
  daemon = await startDaemon({
    port: 0,
    env,
    cwd: workspace,
    writeLockFile: false,
    ...harnessRuntime({
      registry: createHarnessRegistry([
        engineer("vendor-a", "Anthropic-ish", "a.txt"),
        engineer("vendor-b", "OpenAI-ish", "b.txt"),
      ]),
    }),
  });
  const project = daemon.defaultProject;
  if (!project) throw new Error("no project");
  return `${daemon.url}/projects/${project.project.id}`;
}

function formatHook(extra = ""): string {
  return [
    "[hook.format]",
    `command = [${JSON.stringify(process.execPath)}, ${JSON.stringify(formatter)}]`,
    extra,
  ].join("\n");
}

async function ship(base: string): Promise<RunDetailResponse> {
  const response = await fetch(`${base}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "write things", cuesheet: "ship" }),
  });
  expect(response.status).toBe(202);
  const { runId } = (await response.json()) as { runId: string };
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const detail = (await (
      await fetch(`${base}/runs/${runId}`)
    ).json()) as RunDetailResponse;
    if (detail.run.finishedAt) return detail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Run ${runId} never finished`);
}

async function text(file: string): Promise<string> {
  return (await readFile(path.join(workspace, file), "utf8")).replaceAll(
    "\r\n",
    "\n",
  );
}

function hooksOf(detail: RunDetailResponse): HookReport[] {
  return (detail.run.result as RunResultSummary | undefined)?.hooks ?? [];
}

const AFTER_EACH =
  '{ station = "eng-a", action = "implement" }, { hook = "format" }, ' +
  '{ station = "eng-b", action = "implement" }, { hook = "format" }';

describe("hook cues", () => {
  it("runs the project's formatter after every engineer step, whichever vendor ran it", async () => {
    const base = await boot(formatHook(), AFTER_EACH);
    const detail = await ship(base);

    expect(detail.run.status).toBe("done");
    expect(await text("a.txt")).toBe("WRITTEN BY ANTHROPIC-ISH\n");
    expect(await text("b.txt")).toBe("WRITTEN BY OPENAI-ISH\n");
    expect(hooksOf(detail)).toEqual([
      expect.objectContaining({
        hook: "format",
        after: "eng-a",
        outcome: "ok",
        exitCode: 0,
      }),
      expect.objectContaining({
        hook: "format",
        after: "eng-b",
        outcome: "ok",
        exitCode: 0,
      }),
    ]);

    // What each invocation was handed: the run's id, where it sat, and the
    // run's own change so far — the second sees both engineers' files.
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            input: {
              runId: string;
              after: string;
              status: string;
              diff: string;
            };
            env: { run: string; after: string };
          },
      );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toMatchObject({
      runId: detail.run.id,
      after: "eng-a",
      status: "running",
    });
    expect(calls[0]?.input.diff).toContain("a.txt");
    expect(calls[0]?.input.diff).not.toContain("b.txt");
    expect(calls[1]?.input.diff).toContain("b.txt");
    expect(calls[1]?.env).toEqual({ run: detail.run.id, after: "eng-b" });

    // Its output is on the record, attributed to the hook.
    const lines = detail.events.filter(
      (event) => event.t === "text" && event.stationId === "hook:format",
    );
    expect(lines.length).toBe(2);
  });

  it("fails the run when the formatter fails, naming the exit code and its stderr", async () => {
    const failing = path.join(home, "fail.mjs");
    await writeFile(
      failing,
      'console.error("prettier: unexpected token"); process.exit(2);\n',
    );
    const base = await boot(
      `[hook.format]\ncommand = [${JSON.stringify(process.execPath)}, ${JSON.stringify(failing)}]`,
      AFTER_EACH,
    );
    const detail = await ship(base);

    expect(detail.run.status).toBe("failed");
    expect(detail.run.error).toContain("code 2");
    expect(detail.run.error).toContain("unexpected token");
    // It stopped at the first hook: the second engineer never ran.
    await expect(text("b.txt")).rejects.toThrow();
    expect(hooksOf(detail)).toEqual([]);
  });

  it("carries on past a failing hook when on_failure says so, and records that it did", async () => {
    const failing = path.join(home, "fail.mjs");
    await writeFile(failing, "process.exit(1);\n");
    const base = await boot(
      `[hook.format]\ncommand = [${JSON.stringify(process.execPath)}, ${JSON.stringify(failing)}]\non_failure = "continue"`,
      AFTER_EACH,
    );
    const detail = await ship(base);

    expect(detail.run.status).toBe("done");
    expect(await text("b.txt")).toBe("written by OpenAI-ish\n");
    expect(hooksOf(detail)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        exitCode: 1,
        continued: true,
      }),
      expect.objectContaining({
        outcome: "failed",
        exitCode: 1,
        continued: true,
      }),
    ]);
  });

  it("says plainly when the command does not exist", async () => {
    const base = await boot(
      '[hook.format]\ncommand = ["definitely-not-a-formatter-61"]',
      AFTER_EACH,
    );
    const detail = await ship(base);
    expect(detail.run.status).toBe("failed");
    expect(detail.run.error).toContain("could not start");
    expect(detail.run.error).toContain("definitely-not-a-formatter-61");
  });

  it("stops the run at a hook cue that names no configured hook", async () => {
    const base = await boot("", AFTER_EACH);
    const detail = await ship(base);
    expect(detail.run.status).toBe("failed");
    expect(detail.run.error).toContain('hook "format"');
    // The first engineer ran; the missing hook stopped everything after it.
    expect(await text("a.txt")).toBe("written by Anthropic-ish\n");
    await expect(text("b.txt")).rejects.toThrow();
  });
});
