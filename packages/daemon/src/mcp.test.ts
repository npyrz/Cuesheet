import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createHarnessRegistry,
  createMockHarness,
  type Harness,
} from "@cuesheet/harness";
import type { Fact, HostEnv } from "@cuesheet/core";
import { startDaemon, type DaemonHandle } from "./server.js";
import { harnessRuntime } from "./runtime.js";
import { searchFacts } from "./mcp.js";

let daemon: DaemonHandle | null = null;

afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

async function fixture(harness?: Harness): Promise<{
  env: HostEnv;
  root: string;
  projectId: string;
}> {
  const home = await mkdtemp(path.join(tmpdir(), "cuesheet-mcp-"));
  const root = path.join(home, "project");
  await mkdir(root, { recursive: true });
  const selected =
    harness ??
    ({ ...createMockHarness({ standby: false }), id: "mock" } as Harness);
  await writeFile(
    path.join(root, "cuesheet.toml"),
    `
[[station]]
id = "memory-worker"
harness = "${selected.id}"
role = "${selected.roles[0] ?? "worker"}"
workspace = ${JSON.stringify(root)}
paths = ["**"]
`,
    "utf8",
  );
  const env: HostEnv = { platform: process.platform, homedir: home };
  daemon = await startDaemon({
    port: 0,
    env,
    cwd: root,
    writeLockFile: false,
    ...harnessRuntime({ registry: createHarnessRegistry([selected]) }),
  });
  if (!daemon.defaultProject) throw new Error("project was not bootstrapped");
  return { env, root, projectId: daemon.defaultProject.project.id };
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function completedRun(projectId: string): Promise<string> {
  const response = await post(`${daemon!.url}/projects/${projectId}/runs`, {
    prompt: "remember what matters",
  });
  const { runId } = (await response.json()) as { runId: string };
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const stored = await fetch(
      `${daemon!.url}/projects/${projectId}/runs/${runId}`,
    );
    if (stored.ok) {
      const body = (await stored.json()) as { run: { finishedAt?: string } };
      if (body.run.finishedAt) return runId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not finish");
}

describe("Commons MCP", () => {
  it("registers the connector only after its endpoint is listening", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "cuesheet-mcp-wire-"));
    const seen: Array<{ name: string; url?: string }> = [];
    daemon = await startDaemon({
      port: 0,
      env: { platform: process.platform, homedir: home },
      cwd: home,
      writeLockFile: false,
      writeConnectors: async (connectors) => {
        seen.push(...connectors);
        const connector = connectors[0];
        if (connector === undefined || !("url" in connector)) {
          throw new Error("expected an HTTP connector");
        }
        const response = await fetch(connector.url, { method: "GET" });
        expect(response.status).toBe(405);
      },
    });

    expect(seen).toEqual([
      { name: "cuesheet-commons", url: `${daemon.url}/mcp` },
    ]);
  });

  it("recalls a fact that is absent from this project's projection", async () => {
    const { root, projectId } = await fixture();
    const phrase = "the cobalt deployment window is Thursday";
    expect(
      (
        await post(`${daemon!.url}/commons`, {
          id: "visible-convention",
          title: "Visible convention",
          body: "Use the checked-in formatter.",
          projects: [projectId],
        })
      ).status,
    ).toBe(201);
    const created = await post(`${daemon!.url}/commons`, {
      id: "long-tail-deployment",
      title: "Long-tail deployment",
      body: phrase,
      projects: ["proj-somewhere-else"],
    });
    expect(created.status).toBe(201);
    const projected = await readFile(path.join(root, "MOCK.md"), "utf8");
    expect(projected).toContain("Use the checked-in formatter.");
    expect(projected).not.toContain(phrase);

    const client = new Client({ name: "cuesheet-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${daemon!.url}/mcp`),
    );
    await client.connect(transport as unknown as Transport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["memory_search", "memory_write"],
      );
      const result = await client.callTool({
        name: "memory_search",
        arguments: { query: "cobalt deployment" },
      });
      expect(JSON.stringify(result)).toContain(phrase);

      // Project-scoped search keeps the explicit query from leaking another
      // project's fact unless the caller deliberately asks for the global
      // Commons by omitting the scope.
      const scoped = await client.callTool({
        name: "memory_search",
        arguments: { query: "cobalt deployment", project: projectId },
      });
      expect(JSON.stringify(scoped)).not.toContain(phrase);
    } finally {
      await client.close();
    }
  });

  it("sends memory_write through the existing approval inbox", async () => {
    const { projectId } = await fixture();
    const run = await completedRun(projectId);
    const client = new Client({ name: "cuesheet-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${daemon!.url}/mcp`),
      ) as unknown as Transport,
    );
    try {
      const result = await client.callTool({
        name: "memory_write",
        arguments: {
          title: "A captured convention",
          body: "Keep generated identifiers stable.",
          project: projectId,
          station: "memory-worker",
          run,
          tags: ["convention"],
        },
      });
      expect(result.isError).not.toBe(true);
      const inbox = (await (
        await fetch(`${daemon!.url}/commons/inbox`)
      ).json()) as { pending: Array<{ provenance: { run?: string } }> };
      expect(inbox.pending).toHaveLength(1);
      expect(inbox.pending[0]?.provenance.run).toBe(run);
    } finally {
      await client.close();
    }
  });

  it("puts approved projected facts in a local model's brief", async () => {
    let received = "";
    const local: Harness = {
      ...createMockHarness({ standby: false }),
      id: "ollama",
      roles: ["worker"],
      contextFiles: [],
      async run(ctx) {
        received = ctx.brief;
        return { status: "done", cost: ctx.meter.total() };
      },
    };
    const { projectId } = await fixture(local);
    const phrase = "release trains leave on Tuesdays";
    expect(
      (
        await post(`${daemon!.url}/commons`, {
          id: "release-train",
          title: "Release train",
          body: phrase,
          projects: [projectId],
        })
      ).status,
    ).toBe(201);

    await completedRun(projectId);
    expect(received).toContain("# Cuesheet Commons");
    expect(received).toContain(phrase);
    expect(received).toContain("remember what matters");
  });
});

describe("searchFacts", () => {
  const fact = (id: string, title: string, body: string): Fact => ({
    id,
    title,
    body,
    tags: [],
    projects: [],
    provenance: { at: "2026-09-22T00:00:00.000Z" },
  });

  it("ranks title matches ahead of body-only matches deterministically", () => {
    const result = searchFacts(
      [
        fact("body", "Other", "deploy the service"),
        fact("title", "Deploy rules", "Other text"),
      ],
      { query: "deploy" },
    );
    expect(result.map(({ id }) => id)).toEqual(["title", "body"]);
  });
});
