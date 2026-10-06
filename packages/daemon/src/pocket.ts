import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { readFile, stat } from "node:fs/promises";
import nodePath from "node:path";
import type {
  HostEnv,
  PocketStatus,
  PocketStandby,
  ProjectRegistry,
} from "@cuesheet/core";
import type { StandbyRegistry } from "./standby.js";
import {
  openPocketStore,
  pocketOrigin,
  type PocketStore,
} from "./pocket-store.js";
import { redactPocket } from "./pocket-redact.js";

export const POCKET_PORT = 7374;
export interface PocketOptions {
  uiDir?: string;
  port?: number;
  now?: () => number;
}
interface Deps {
  env: HostEnv;
  standbys: StandbyRegistry;
  registry: ProjectRegistry;
  options: PocketOptions;
}

const bodyOf = (request: FastifyRequest): Record<string, unknown> =>
  request.body !== null &&
  typeof request.body === "object" &&
  !Array.isArray(request.body)
    ? (request.body as Record<string, unknown>)
    : {};
const credential = (request: FastifyRequest): string =>
  /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.authorization ?? "",
  )?.[1] ?? "";

/** A second listener in the same daemon, with no route to its unrestricted API. */
export async function createPocket(deps: Deps) {
  let store: PocketStore | null = null;
  let remote: FastifyInstance | null = null;
  let port: number | null = null;
  let error: string | null = null;
  let operations: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = operations.then(work, work);
    operations = next.catch(() => undefined);
    return next;
  };
  const required = (): PocketStore => {
    if (!store)
      throw new Error(
        "Pocket state could not be read. Inspect ~/.cuesheet/pocket.json before enabling it.",
      );
    return store;
  };
  const status = (): PocketStatus => ({
    enabled: remote !== null,
    origin: store?.origin() ?? null,
    port,
    devices: store?.devices() ?? [],
    error,
  });

  async function pending(): Promise<PocketStandby[]> {
    const questions = deps.standbys.list();
    const projects = new Map(
      (await deps.registry.list()).map((p) => [p.id, p.name]),
    );
    return questions.map((s) => ({
      id: s.id,
      runId: s.runId,
      project: redactPocket(projects.get(s.projectId ?? "") ?? "Project"),
      station: s.stationId === undefined ? null : redactPocket(s.stationId),
      kind: s.kind,
      ask: redactPocket(s.ask),
      at: s.at,
    }));
  }

  async function listen(): Promise<void> {
    const uiDir = deps.options.uiDir;
    if (
      !uiDir ||
      !(
        await stat(nodePath.join(uiDir, "index.html")).catch(() => null)
      )?.isFile()
    )
      throw new Error("Build the Desk before enabling Pocket: npm run build.");
    const app = Fastify({ logger: false, bodyLimit: 4096 });
    app.setErrorHandler((cause, _request, reply) => {
      const code =
        cause instanceof Error &&
        "statusCode" in cause &&
        typeof cause.statusCode === "number"
          ? cause.statusCode
          : 500;
      return reply.code(code && code >= 400 && code < 500 ? code : 500).send({
        error:
          "Pocket could not handle this request. Refresh, or check the local Desk.",
      });
    });
    let failures = 0;
    let windowStart = 0;
    const now = deps.options.now ?? Date.now;
    app.addHook("onRequest", async (request, reply) => {
      reply
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff")
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== required().origin())
        return reply
          .code(403)
          .send({ error: "Pocket accepts only its configured HTTPS origin." });
      if (request.method !== "GET" && origin !== required().origin())
        return reply
          .code(403)
          .send({ error: "Open Pocket at its configured HTTPS URL." });
      const path = request.url.split("?")[0] ?? "";
      if (!path.startsWith("/api/")) return;
      // No token ever travels in a URL, including on reconnect.
      if (request.url.includes("?"))
        return reply.code(400).send({ error: "Use the Authorization header." });
      if (now() - windowStart >= 60_000) {
        failures = 0;
        windowStart = now();
      }
      const pairing = path === "/api/pocket/pair" && request.method === "POST";
      if (!pairing && required().authenticate(credential(request))) return;
      if (failures >= 30)
        return reply.code(429).send({
          error: "Too many invalid credentials. Try again in a minute.",
        });
      if (!pairing) {
        failures += 1;
        return reply.code(401).send({
          error:
            "This phone is unpaired, expired, or revoked. Scan a new QR in the Desk.",
        });
      }
    });
    app.get("/", async (_request, reply) => reply.redirect("/pocket"));
    app.get("/pocket/", async (_request, reply) => reply.redirect("/pocket"));
    app.get("/pocket", async (_request, reply) =>
      reply
        .type("text/html")
        .send(await readFile(nodePath.join(uiDir, "index.html"))),
    );
    app.get("/assets/:file", async (request, reply) => {
      const file = (request.params as { file: string }).file;
      if (!/^[A-Za-z0-9_-]+\.(?:js|css)$/.test(file))
        return reply.code(404).send();
      try {
        return reply
          .type(file.endsWith(".js") ? "text/javascript" : "text/css")
          .send(await readFile(nodePath.join(uiDir, "assets", file)));
      } catch {
        return reply.code(404).send();
      }
    });
    app.post("/api/pocket/pair", async (request, reply) => {
      const body = bodyOf(request);
      try {
        return await serial(() => required().pair(body["token"], body["name"]));
      } catch {
        failures += 1;
        return reply.code(400).send({
          error:
            "Pairing failed. Name the phone, or generate a fresh QR in the Desk.",
        });
      }
    });
    app.get("/api/pocket/standbys", async () => ({
      standbys: await pending(),
    }));
    app.post("/api/pocket/standbys/:id", async (request, reply) => {
      const answer = bodyOf(request)["answer"];
      if (answer !== "go" && answer !== "no")
        return reply.code(400).send({ error: "Choose GO or NO." });
      const id = (request.params as { id: string }).id;
      const settled = await serial(async () => {
        if (!required().authenticate(credential(request)))
          return "unauthorized" as const;
        return deps.standbys.resolve(id, answer);
      });
      if (settled === "unauthorized")
        return reply
          .code(401)
          .send({ error: "This phone was revoked or expired." });
      if (!settled)
        return reply.code(409).send({
          error:
            "This standby was answered or the run ended. Refresh the list.",
        });
      // The local route returns the original ask, which must never bypass redaction here.
      return { id, answer };
    });
    app.delete("/api/pocket/session", async (request) => {
      const device = required().authenticate(credential(request));
      if (device) await serial(() => required().revoke(device.id));
      return { ok: true };
    });
    try {
      await app.listen({
        host: "127.0.0.1",
        port: deps.options.port ?? POCKET_PORT,
      });
      const address = app.addresses()[0];
      port = address?.port ?? null;
      remote = app;
    } catch (cause) {
      await app.close();
      throw cause;
    }
  }

  try {
    store = await openPocketStore(deps.env, deps.options.now);
    if (store.enabled()) await listen();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Pocket could not start.";
  }

  return {
    status,
    register(app: FastifyInstance) {
      app.register(
        async (scope) => {
          scope.addHook("onRequest", async (request, reply) => {
            const origin = request.headers.origin;
            if (origin !== undefined && origin !== "null") {
              let local = false;
              try {
                local = ["127.0.0.1", "localhost", "[::1]"].includes(
                  new URL(origin).hostname,
                );
              } catch {
                /* A malformed origin is never local. */
              }
              if (!local)
                return reply
                  .code(403)
                  .send({ error: "Manage Pocket from the local Desk." });
            }
            if (
              request.method !== "GET" &&
              !request.headers["content-type"]?.startsWith("application/json")
            )
              return reply
                .code(415)
                .send({ error: "Pocket administration requires JSON." });
            reply.header("Cache-Control", "no-store");
          });
          scope.get("/settings", async () => status());
          scope.post("/settings", async (request, reply) => {
            const cleanup: { listener: FastifyInstance | null } = {
              listener: null,
            };
            try {
              const origin = pocketOrigin(bodyOf(request)["origin"]);
              await serial(async () => {
                required();
                if (!remote) await listen();
                try {
                  await required().configure(origin);
                } catch (cause) {
                  cleanup.listener = remote;
                  remote = null;
                  port = null;
                  throw cause;
                }
                error = null;
              });
              return status();
            } catch (cause) {
              await cleanup.listener?.close();
              return reply.code(400).send({
                error:
                  cause instanceof Error
                    ? cause.message
                    : "Pocket could not start.",
              });
            }
          });
          scope.delete("/settings", async () => {
            const closing = await serial(async () => {
              await required().configure(null);
              const listener = remote;
              remote = null;
              port = null;
              error = null;
              return listener;
            });
            // Closing waits for in-flight requests, some of which need the
            // mutation queue. Holding that queue here would deadlock disable.
            await closing?.close();
            return status();
          });
          scope.post("/invitation", async () =>
            serial(async () => {
              if (!remote) throw new Error("Enable Pocket first.");
              return required().invite();
            }),
          );
          scope.delete("/invitation", async () =>
            serial(async () => {
              required().cancelInvitation();
              return { ok: true };
            }),
          );
          scope.delete("/devices/:id", async (request) =>
            serial(async () => {
              await required().revoke((request.params as { id: string }).id);
              return status();
            }),
          );
        },
        { prefix: "/pocket" },
      );
    },
    async close() {
      const closing = await serial(async () => {
        const listener = remote;
        remote = null;
        port = null;
        return listener;
      });
      await closing?.close();
    },
  };
}
