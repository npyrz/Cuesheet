/**
 * The Commons over MCP.
 *
 * The daemon already owns the store, the approval boundary, and the one
 * loopback port every client can find. Serving Streamable HTTP here keeps MCP
 * another view of that same product instead of a sidecar with a second copy
 * of any of those decisions.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { Fact } from "@cuesheet/core";
import type { CommonsStore } from "./commons.js";
import { DAEMON_VERSION } from "./version.js";

export interface MemoryWriteInput {
  title: string;
  body: string;
  project: string;
  station: string;
  run: string;
  tags: string[];
}

export interface CommonsMcpOptions {
  store: CommonsStore;
  /** The same promotion boundary the HTTP capture route uses. */
  capture(input: MemoryWriteInput): Promise<unknown>;
}

export interface CommonsMcpHandler {
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: unknown,
  ): Promise<void>;
}

export function createCommonsMcpHandler(
  options: CommonsMcpOptions,
): CommonsMcpHandler {
  return {
    async handle(request, response, body) {
      // Stateless by design: both tools read all durable state from the
      // Commons and the project runtimes. A session map would add lifecycle
      // state while buying these request/response tools nothing.
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      const server = commonsServer(options);
      // The SDK publishes optional callback properties as `T | undefined`,
      // which is structurally incompatible with this repo's
      // `exactOptionalPropertyTypes` even though it is the SDK's own transport
      // implementing the SDK's own interface. Keep the workaround at that
      // dependency boundary rather than weakening checking for the package.
      await server.connect(transport as unknown as Transport);
      try {
        await transport.handleRequest(request, response, body);
      } finally {
        await server.close();
      }
    },
  };
}

function commonsServer(options: CommonsMcpOptions): McpServer {
  const server = new McpServer({
    name: "cuesheet-commons",
    version: DAEMON_VERSION,
  });

  server.registerTool(
    "memory_search",
    {
      title: "Search the Cuesheet Commons",
      description:
        "Search approved durable memory. Pass a project id to include user-level facts and facts tagged for that project; omit it to search the whole operator-owned Commons.",
      inputSchema: {
        query: z.string().max(500).default(""),
        project: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(20).default(8),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, project, limit }) => {
      const facts = searchFacts(await options.store.list(), {
        query,
        ...(project !== undefined && { project }),
        limit,
      });
      return {
        content: [
          {
            type: "text",
            text:
              facts.length === 0
                ? "No approved Commons facts matched."
                : facts.map(renderFact).join("\n\n"),
          },
        ],
        structuredContent: { facts },
      };
    },
  );

  server.registerTool(
    "memory_write",
    {
      title: "Capture a Commons memory",
      description:
        "Capture durable memory through the project's approval policy. Use the project, station, and run identifiers from the Cuesheet memory context in your brief.",
      inputSchema: {
        title: z.string().min(1).max(200),
        body: z.string().max(50_000),
        project: z.string().min(1),
        station: z.string().min(1),
        run: z.string().min(1),
        tags: z.array(z.string()).max(50).default([]),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const captured = await options.capture(input);
        return {
          content: [
            {
              type: "text",
              text: "Memory captured through the project's Commons approval policy.",
            },
          ],
          structuredContent: { capture: captured },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );

  return server;
}

export interface MemorySearch {
  query: string;
  project?: string;
  limit?: number;
}

/** A small deterministic ranker; the plain files remain the search index. */
export function searchFacts(
  facts: readonly Fact[],
  search: MemorySearch,
): Fact[] {
  const terms = search.query
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 0);
  const scopedProject = search.project;
  const visible =
    scopedProject === undefined
      ? facts
      : facts.filter(
          (fact) =>
            fact.projects.length === 0 || fact.projects.includes(scopedProject),
        );

  return visible
    .map((fact) => ({ fact, score: relevance(fact, terms) }))
    .filter(({ score }) => terms.length === 0 || score > 0)
    .sort((a, b) => b.score - a.score || ascii(a.fact.id, b.fact.id))
    .slice(0, search.limit ?? 8)
    .map(({ fact }) => fact);
}

function relevance(fact: Fact, terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  const title = `${fact.id} ${fact.title}`.toLocaleLowerCase("en-US");
  const tags = fact.tags.join(" ").toLocaleLowerCase("en-US");
  const body = fact.body.toLocaleLowerCase("en-US");
  return terms.reduce(
    (score, term) =>
      score +
      (title.includes(term) ? 8 : 0) +
      (tags.includes(term) ? 4 : 0) +
      (body.includes(term) ? 1 : 0),
    0,
  );
}

function ascii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function renderFact(fact: Fact): string {
  const scope =
    fact.projects.length === 0
      ? "user"
      : `projects: ${fact.projects.join(", ")}`;
  return `## ${fact.title}\n\n${fact.body}\n\n[${fact.id}; ${scope}]`;
}
