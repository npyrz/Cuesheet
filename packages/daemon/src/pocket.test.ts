import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configDir,
  type HostEnv,
  type PocketInvitation,
  type PocketStatus,
  type PocketStandby,
} from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";

const ORIGIN = "https://computer.tail123.ts.net";
let env: HostEnv;
let daemon: DaemonHandle;
let uiDir: string;
let now: number;
let remote: string;
beforeEach(async () => {
  env = {
    platform: process.platform,
    homedir: await mkdtemp(nodePath.join(tmpdir(), "cuesheet-pocket-")),
  };
  uiDir = nodePath.join(env.homedir, "ui");
  await mkdir(nodePath.join(uiDir, "assets"), { recursive: true });
  await writeFile(nodePath.join(uiDir, "index.html"), "<html>Pocket</html>");
  await writeFile(
    nodePath.join(uiDir, "assets", "index-test.js"),
    "/* test */",
  );
  now = Date.now();
  daemon = await boot();
});
afterEach(async () => {
  await daemon?.close();
  await rm(env.homedir, { recursive: true, force: true });
});

const boot = () =>
  startDaemon({
    env,
    cwd: env.homedir,
    port: 0,
    writeLockFile: false,
    storeBackend: "files",
    pocket: { port: 0, uiDir, now: () => now },
    executor: async (ctx) => {
      const answer = await ctx.ask({
        kind: "hold",
        ask: "Security finding. API_TOKEN=private-value. Override and continue?",
        stationId: "engineer",
      });
      return {
        status: answer === "go" ? "done" : "held",
        cost: { tokensIn: 0, tokensOut: 0 },
        durationMs: 0,
      };
    },
  });
async function local<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${daemon.url}/api/pocket${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(method !== "GET" && { body: JSON.stringify(body ?? {}) }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}
async function enable() {
  const status = await local<PocketStatus>("/settings", "POST", {
    origin: ORIGIN,
  });
  expect(status.enabled).toBe(true);
  remote = `http://127.0.0.1:${status.port}`;
}
const phone = (
  path: string,
  token?: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) =>
  fetch(`${remote}${path}`, {
    method,
    headers: {
      Origin: ORIGIN,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
async function pair() {
  const invite = await local<PocketInvitation>("/invitation", "POST");
  const response = await phone("/api/pocket/pair", undefined, {
    token: new URL(invite.url).hash.slice(6),
    name: "Test phone",
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { token: string; expiresAt: string };
}
async function waitFor(ready: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await ready())) {
    if (Date.now() > deadline)
      throw new Error("Pocket run did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("Pocket over HTTP", () => {
  it("is off by default and refuses binding the Desk to a network interface", async () => {
    expect(await local<PocketStatus>("/settings")).toMatchObject({
      enabled: false,
      port: null,
      devices: [],
    });
    await expect(
      startDaemon({ env, host: "0.0.0.0", port: 0 }),
    ).rejects.toThrow(/must stay on loopback/);
    const response = await fetch(`${daemon.url}/api/pocket/settings`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ origin: ORIGIN }),
    });
    expect(response.status).toBe(403);
    const form = await fetch(`${daemon.url}/pocket/settings`, {
      method: "POST",
      body: "origin=x",
    });
    expect(form.status).toBe(415);
  });

  it("serves the phone shell but never the Desk API, MCP, paths, logs or diagnostics", async () => {
    await enable();
    const shell = await phone("/pocket");
    expect(await shell.text()).toContain("Pocket");
    expect(shell.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(shell.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await phone("/assets/index-test.js")).status).toBe(200);
    expect((await phone("/assets/index-test.js.map")).status).toBe(404);
    expect((await phone("/api/pocket/standbys")).status).toBe(401);
    const { token } = await pair();
    for (const path of [
      "/api/projects",
      "/api/diagnostics/report",
      "/api/mcp",
      "/api/pocket/settings",
      "/api/pocket/invitation",
      "/projects",
      "/mcp",
      "/diagnostics",
    ]) {
      expect((await phone(path, token)).status).toBe(404);
    }
    const foreign = await fetch(`${remote}/api/pocket/standbys`, {
      headers: {
        Origin: "https://evil.example",
        Authorization: `Bearer ${token}`,
      },
    });
    expect(foreign.status).toBe(403);
    const query = await phone(`/api/pocket/standbys?token=${token}`);
    expect(query.status).toBe(400);
    expect(query.headers.get("cache-control")).toBe("no-store");
  });

  it("a single QR cannot mint two phones, including concurrent exchanges", async () => {
    await enable();
    const invite = await local<PocketInvitation>("/invitation", "POST");
    const body = { token: new URL(invite.url).hash.slice(6), name: "Phone" };
    const responses = await Promise.all([
      phone("/api/pocket/pair", undefined, body),
      phone("/api/pocket/pair", undefined, body),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    expect((await local<PocketStatus>("/settings")).devices).toHaveLength(1);
  });

  it("a paired phone answers real queues across projects; duplicate or stale answers cannot act", async () => {
    await enable();
    const { token } = await pair();
    const projects = await Promise.all(
      ["api", "web"].map(async (name) => {
        const root = nodePath.join(env.homedir, name);
        await mkdir(root);
        await writeFile(
          nodePath.join(root, "cuesheet.toml"),
          `[[station]]\nid="engineer"\nharness="mock"\nrole="engineer"\nworkspace="${root.replaceAll("\\", "/")}"\n`,
        );
        return daemon.registry.open(root);
      }),
    );
    const runIds: string[] = [];
    for (const project of projects) {
      const response = await fetch(
        `${daemon.url}/projects/${project.id}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Run this" }),
        },
      );
      expect(response.status).toBe(202);
      const result = (await response.json()) as { runId: string };
      runIds.push(result.runId);
    }
    await waitFor(async () => daemon.standbys.list().length === 2);
    const response = await phone("/api/pocket/standbys", token);
    const { standbys } = (await response.json()) as {
      standbys: PocketStandby[];
    };
    expect(standbys.map((s) => s.project).sort()).toEqual(["api", "web"]);
    expect(JSON.stringify(standbys)).not.toContain("private-value");
    expect(JSON.stringify(standbys)).not.toContain(env.homedir);
    const firstQuestion = standbys[0];
    if (!firstQuestion) throw new Error("Missing standby.");
    expect(
      (
        await phone(`/api/pocket/standbys/${firstQuestion.id}`, undefined, {
          answer: "go",
        })
      ).status,
    ).toBe(401);
    expect(daemon.standbys.list()).toHaveLength(2);
    for (let i = 0; i < standbys.length; i++) {
      const question = standbys[i];
      if (!question) throw new Error("Missing standby.");
      const path = `/api/pocket/standbys/${question.id}`;
      expect((await phone(path, token, { answer: "maybe" })).status).toBe(400);
      expect(
        (await phone(path, token, { answer: i === 0 ? "go" : "no" })).status,
      ).toBe(200);
      expect((await phone(path, token, { answer: "go" })).status).toBe(409);
    }
    await waitFor(async () => {
      const statuses = await Promise.all(
        projects.map(
          async (p, i) =>
            (
              await (
                await daemon.projects.get(p.id)
              )?.store.get(runIds[i] ?? "")
            )?.run.status,
        ),
      );
      return statuses.every((s) => s === "done" || s === "held");
    });
    const statuses = await Promise.all(
      projects.map(
        async (p, i) =>
          (await (await daemon.projects.get(p.id))?.store.get(runIds[i] ?? ""))
            ?.run.status,
      ),
    );
    expect(statuses.sort()).toEqual(["done", "held"]);
    expect(daemon.standbys.list()).toEqual([]);
  });

  it("disabling during pairing drains requests without keeping any device authorized", async () => {
    await enable();
    const invite = await local<PocketInvitation>("/invitation", "POST");
    const requests = Array.from({ length: 10 }, () =>
      phone("/api/pocket/pair", undefined, {
        token: new URL(invite.url).hash.slice(6),
        name: "Phone",
      }),
    );
    const disabled = local<PocketStatus>("/settings", "DELETE");
    const outcomes = await Promise.allSettled(requests);
    for (const outcome of outcomes) {
      if (outcome.status === "fulfilled")
        expect([200, 400, 503]).toContain(outcome.value.status);
      else expect(outcome.reason).toBeInstanceOf(Error);
    }
    expect(await disabled).toMatchObject({ enabled: false, devices: [] });
    await expect(fetch(`${remote}/pocket`)).rejects.toThrow();
  });

  it("a missing UI gives a remedy without starting a partial phone service", async () => {
    await rm(nodePath.join(uiDir, "index.html"));
    const response = await fetch(`${daemon.url}/pocket/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: ORIGIN }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("npm run build"),
    });
    expect(await local<PocketStatus>("/settings")).toMatchObject({
      enabled: false,
      port: null,
    });
    expect((await fetch(`${daemon.url}/health`)).status).toBe(200);
  });

  it("revocation, expiry, restart and disable fail closed", async () => {
    await enable();
    const first = await pair();
    await daemon.close();
    daemon = await boot();
    const status = await local<PocketStatus>("/settings");
    remote = `http://127.0.0.1:${status.port}`;
    expect((await phone("/api/pocket/standbys", first.token)).status).toBe(200);
    await local(`/devices/${status.devices[0]?.id}`, "DELETE");
    expect((await phone("/api/pocket/standbys", first.token)).status).toBe(401);
    const second = await pair();
    now = Date.parse(second.expiresAt);
    expect((await phone("/api/pocket/standbys", second.token)).status).toBe(
      401,
    );
    expect((await local<PocketStatus>("/settings", "DELETE")).enabled).toBe(
      false,
    );
    await expect(fetch(`${remote}/pocket`)).rejects.toThrow();
    await daemon.close();
    daemon = await boot();
    expect((await local<PocketStatus>("/settings")).enabled).toBe(false);
  });

  it("a flood of invalid credentials cannot block an already paired phone", async () => {
    await enable();
    const { token } = await pair();
    for (let i = 0; i < 30; i++)
      await phone("/api/pocket/standbys", "a".repeat(43));
    expect(
      (
        await phone("/api/pocket/pair", undefined, {
          token: "bad",
          name: "Phone",
        })
      ).status,
    ).toBe(429);
    expect((await phone("/api/pocket/standbys", token)).status).toBe(200);
    now += 60_000;
    expect((await phone("/api/pocket/standbys", "a".repeat(43))).status).toBe(
      401,
    );
  });

  it("bad Pocket state leaves the Desk running and the file untouched", async () => {
    await enable();
    await daemon.close();
    const file = nodePath.join(configDir(env), "pocket.json");
    await writeFile(file, "broken");
    daemon = await boot();
    expect((await fetch(`${daemon.url}/health`)).status).toBe(200);
    expect(await local<PocketStatus>("/settings")).toMatchObject({
      enabled: false,
      port: null,
      error: expect.any(String),
    });
    expect(await readFile(file, "utf8")).toBe("broken");
  });
});
