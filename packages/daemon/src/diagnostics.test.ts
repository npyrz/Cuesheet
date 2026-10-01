import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEnv, RunEvent } from "@cuesheet/core";
import { createDiagnostics, type Diagnostics } from "./diagnostics.js";
import { startDaemon } from "./server.js";

let root: string;
let env: HostEnv;
const services: Diagnostics[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cuesheet-diagnostics-"));
  env = { platform: process.platform, homedir: root };
});
afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await rm(root, { recursive: true, force: true });
});
function service(): Diagnostics {
  const diagnostic = createDiagnostics(env);
  services.push(diagnostic);
  return diagnostic;
}
const runId = "20260930T120000000Z-0000";

// Use a real built daemon in a separate process: calling close() in-process
// would exercise graceful shutdown, not the crash this acceptance bar names.
async function crashRun(
  mode: "kill" | "fatal",
): Promise<{ run: string; project: string }> {
  const module = pathToFileURL(
    join(process.cwd(), "packages/daemon/dist/index.js"),
  ).href;
  const code = `
    import { startDaemon } from ${JSON.stringify(module)};
    const home = process.argv[1];
    let projectId;
    const handle = await startDaemon({ port: 0, env: { platform: process.platform, homedir: home }, cwd: home, writeLockFile: false,
      executor: async (ctx) => {
        ctx.emit({ t: 'text', at: new Date().toISOString(), runId: ctx.run.id, stationId: 'private-station', chunk: 'SECRET_MODEL_OUTPUT' });
        // Wait for the partial event to reach the store, not a fixed timeout.
        while (!(await (await handle.projects.get(projectId)).store.get(ctx.run.id)).events.some((event) => event.t === 'text')) await new Promise((resolve) => setImmediate(resolve));
        console.log(JSON.stringify({ run: ctx.run.id }));
        ${mode === "fatal" ? "setImmediate(() => { throw new TypeError('SECRET_FATAL_MESSAGE'); });" : ""}
        await new Promise(() => {});
      }
    });
    const project = await handle.registry.open(home);
    projectId = project.id;
    const runtime = await handle.projects.get(project.id);
    console.log(JSON.stringify({ project: project.id }));
    await runtime.queue.enqueue({ prompt: 'SECRET_PROMPT', stationIds: ['private-station'], workspace: home });
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, root],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
  let output = "";
  let stderr = "";
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"run":')) resolve();
    });
    child.once("exit", () => {
      if (!output.includes('"run":')) reject(new Error(stderr));
    });
    child.once("error", reject);
  });
  try {
    await ready;
    if (mode === "kill") child.kill("SIGKILL");
    await exited;
    const lines = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { run?: string; project?: string });
    return {
      run: lines.find((line) => line.run)?.run ?? "",
      project: lines.find((line) => line.project)?.project ?? "",
    };
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
}

describe("local diagnostics", () => {
  it.each(["kill", "fatal"] as const)(
    "exports a report after a real %s mid-run and preserves the run record",
    async (mode) => {
      const crashed = await crashRun(mode);
      const daemon = await startDaemon({
        port: 0,
        env,
        cwd: root,
        writeLockFile: false,
      });
      try {
        const runtime = await daemon.projects.get(crashed.project);
        const stored = await runtime?.store.get(crashed.run);
        expect(stored?.run.status).toBe("interrupted");
        expect(stored?.events.some((event) => event.t === "text")).toBe(true);
        const response = await daemon.app.inject("/api/diagnostics/report");
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-disposition"]).toContain(
          "cuesheet-diagnostics.txt",
        );
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).toContain(crashed.run);
        expect(response.body).toContain("run-at-process-loss");
        expect(response.body).toContain("run-reconciled-interrupted");
        if (mode === "fatal") expect(response.body).toContain("process-fatal");
        for (const secret of [
          root,
          "SECRET_PROMPT",
          "SECRET_MODEL_OUTPUT",
          "SECRET_FATAL_MESSAGE",
          "private-station",
          crashed.project,
        ])
          expect(response.body).not.toContain(secret);
        const info = await daemon.app.inject("/diagnostics");
        expect(info.json()).toEqual({
          path: daemon.diagnostics.path,
          available: true,
        });
      } finally {
        await daemon.close();
      }
    },
    15000,
  );

  it("selects only context, never tool payloads, error messages or paths", async () => {
    const diagnostic = service();
    diagnostic.start();
    const common = { at: new Date().toISOString(), runId };
    const events: RunEvent[] = [
      { ...common, t: "status", status: "running" },
      {
        ...common,
        t: "tool",
        stationId: "SECRET_STATION",
        name: "SECRET_TOOL",
        input: { token: "SECRET_TOKEN" },
      },
      {
        ...common,
        t: "file",
        stationId: "SECRET_STATION",
        path: "SECRET_PATH",
        op: "write",
      },
      {
        ...common,
        t: "standby",
        standbyId: "SECRET_STANDBY",
        ask: "SECRET_ASK",
      },
      { ...common, t: "error", message: "SECRET_ERROR" },
    ];
    for (const event of events) diagnostic.observe("SECRET_PROJECT", event);
    const error = new TypeError("SECRET_MESSAGE");
    error.stack =
      "TypeError: SECRET_MESSAGE\n    at SECRET_FUNCTION (/private/SECRET_HOME/server.ts:12:4)";
    diagnostic.error("http-error", error);
    const report = diagnostic.report();
    expect(report).toContain("server.ts:12:4");
    expect(report).toContain("TypeError");
    expect(report).not.toContain("SECRET_");
    expect(report).not.toContain(root);
    const checkpoint = await readFile(
      join(root, ".cuesheet/diagnostics/session.json"),
      "utf8",
    );
    expect(checkpoint).toContain(runId);
    expect(checkpoint).not.toContain("SECRET_");
    if (process.platform !== "win32")
      expect((await stat(diagnostic.path)).mode & 0o777).toBe(0o600);
  });

  it("does not classify a clean shutdown as a crash or retain terminal runs", async () => {
    const diagnostic = service();
    diagnostic.start();
    diagnostic.observe("project", {
      t: "status",
      at: "now",
      runId,
      status: "running",
    });
    diagnostic.observe("project", {
      t: "status",
      at: "now",
      runId,
      status: "interrupted",
    });
    expect(
      JSON.parse(
        await readFile(
          join(root, ".cuesheet/diagnostics/session.json"),
          "utf8",
        ),
      ).active,
    ).toEqual([]);
    diagnostic.close();
    const next = service();
    next.start();
    expect(next.report()).not.toContain("previous-session-unclean");
  });

  it("bounds retention and keeps the newest error across rotations", async () => {
    const diagnostic = service();
    diagnostic.start();
    for (let i = 0; i < 4; i++) {
      await writeFile(diagnostic.path, `${" ".repeat(512 * 1024)}\n`);
      diagnostic.error("http-error", new Error("secret"));
    }
    expect(diagnostic.report()).toContain("http-error");
    const files = [
      diagnostic.path,
      `${diagnostic.path}.1`,
      `${diagnostic.path}.2`,
    ];
    for (const file of files)
      expect((await stat(file)).size).toBeLessThan(513 * 1024);
    await expect(stat(`${diagnostic.path}.3`)).rejects.toThrow();
  });

  it("reports unavailable storage without breaking daemon requests", async () => {
    await writeFile(join(root, ".cuesheet"), "blocking file");
    const diagnostic = service();
    diagnostic.start();
    expect(diagnostic.available()).toBe(false);
    expect(() => diagnostic.report()).toThrow();
    // A separately isolated daemon can use the failing sink while its stores
    // remain writable: diagnostics are never a precondition for serving work.
    const home = await mkdtemp(join(tmpdir(), "cuesheet-diagnostic-api-"));
    const daemon = await startDaemon({
      port: 0,
      env: { platform: process.platform, homedir: home },
      cwd: home,
      writeLockFile: false,
      diagnostics: diagnostic,
    });
    try {
      expect((await daemon.app.inject("/health")).statusCode).toBe(200);
      expect((await daemon.app.inject("/diagnostics/report")).statusCode).toBe(
        503,
      );
    } finally {
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
