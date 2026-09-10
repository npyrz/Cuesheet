/**
 * `cuesheetd` — the HTTP + WebSocket surface.
 *
 * This is the product. The Desk, the CLI, and later the phone are all clients
 * of exactly these routes, so there are no Electron-only shortcuts here: if
 * the app can do it, it is an HTTP call, and M3's phone gets it for free.
 *
 * Bound to loopback. Nothing here is authenticated, which is fine only
 * because nothing here is reachable off the machine — pairing tokens and a
 * tailnet are M3, and that is the point at which this comment has to change.
 */
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import {
  DEFAULT_PORT,
  hostEnv,
  loadConfig,
  type HostEnv,
  type LoadedConfig,
  type RunEvent,
} from "@cuesheet/core";
import { createEventBus, DEFAULT_REPLAY_LIMIT, type EventBus } from "./bus.js";
import { createFileRunStore, type RunStore } from "./store.js";
import { createRunQueue, type RunQueue } from "./queue.js";
import { noopExecutor, type RunExecutor } from "./executor.js";
import { createStandbyRegistry, type StandbyRegistry } from "./standby.js";
import { describeStations, unprobed, type HarnessProber } from "./stations.js";
import { isRunId } from "./ids.js";
import {
  currentLock,
  findRunningDaemon,
  PortInUseError,
  removeLock,
  writeLock,
} from "./lockfile.js";
import { DAEMON_VERSION } from "./version.js";

export interface StartDaemonOptions {
  /** `0` binds an ephemeral port — what tests use, so they never collide. */
  port?: number;
  host?: string;
  env?: HostEnv;
  /** Where to look for `cuesheet.toml`. */
  cwd?: string;
  executor?: RunExecutor;
  store?: RunStore;
  bus?: EventBus;
  prober?: HarnessProber;
  replayLimit?: number;
  /** Off in tests, so a test run never clobbers a real daemon's lockfile. */
  writeLockFile?: boolean;
  logger?: boolean;
}

export interface DaemonHandle {
  /** The port actually bound, which is what matters when `port` was `0`. */
  port: number;
  host: string;
  url: string;
  app: FastifyInstance;
  bus: EventBus;
  store: RunStore;
  queue: RunQueue;
  standbys: StandbyRegistry;
  /** Reload `cuesheet.toml` from disk. */
  reloadConfig(): Promise<LoadedConfig>;
  close(): Promise<void>;
}

/**
 * Boot the daemon.
 *
 * Returns a handle rather than nothing, and the handle carries the *bound*
 * port. Every test and both embedders depend on that: `port: 0` plus
 * `handle.port` is what lets vitest run these files in parallel workers
 * without fighting each other or a dev daemon on 7373.
 */
export async function startDaemon(
  options: StartDaemonOptions = {},
): Promise<DaemonHandle> {
  const env = options.env ?? hostEnv();
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? DEFAULT_PORT;
  const cwd = options.cwd ?? process.cwd();
  const writeLockFile = options.writeLockFile ?? true;

  const bus =
    options.bus ??
    createEventBus({
      replayLimit: options.replayLimit ?? DEFAULT_REPLAY_LIMIT,
    });
  const store = options.store ?? createFileRunStore({ env });
  const standbys = createStandbyRegistry();
  const queue = createRunQueue({
    store,
    bus,
    standbys,
    executor: options.executor ?? noopExecutor,
  });
  const prober = options.prober ?? unprobed;

  // Config is loaded once and cached: `/stations` is polled by the UI and
  // re-reading TOML on every poll is a syscall storm for no benefit.
  let loaded = await loadConfig(cwd, env);

  const app = Fastify({ logger: options.logger ?? false });

  // Treat an empty JSON body as `{}`.
  //
  // `POST /runs/:id/stop` and a "no body" POST from a fetch that still sets
  // `content-type: application/json` are both legitimate, and Fastify's
  // default parser rejects them with a 400 that looks like a client bug. The
  // route handlers already validate their own bodies, so an empty object is
  // the honest parse. Registered on the root instance so the `/api` scope
  // inherits it rather than re-registering and conflicting.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, next) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text === "") return next(null, {});
      try {
        next(null, JSON.parse(text));
      } catch (error) {
        next(error as Error);
      }
    },
  );

  await app.register(websocket);

  registerRoutes(app, {
    bus,
    store,
    queue,
    standbys,
    prober,
    config: () => loaded,
  });
  // The same routes under `/api` as well, because Step 17's Vite dev server
  // proxies `/api` and `/ws`. One registration with a prefix beats a rewrite
  // rule in the dev config and keeps `curl :7373/health` working.
  await app.register(
    async (scope) => {
      registerRoutes(scope, {
        bus,
        store,
        queue,
        standbys,
        prober,
        config: () => loaded,
      });
    },
    { prefix: "/api" },
  );

  let boundPort: number;
  try {
    await app.listen({ host, port: requestedPort });
    boundPort = addressPort(app) ?? requestedPort;
  } catch (error) {
    await app.close().catch(() => undefined);
    if (isPortUnavailable(error)) {
      // Deliberately not falling back to another port. The CLI and the app
      // find the daemon by a known port in a known lockfile; silently moving
      // turns "already running" into "running but undiscoverable".
      const existing = await findRunningDaemon(env);
      throw new PortInUseError(requestedPort, host, existing);
    }
    throw error;
  }

  if (writeLockFile) {
    await writeLock(currentLock(boundPort), env);
  }

  let closed = false;
  return {
    port: boundPort,
    host,
    url: `http://${host}:${boundPort}`,
    app,
    bus,
    store,
    queue,
    standbys,
    async reloadConfig() {
      loaded = await loadConfig(cwd, env);
      return loaded;
    },
    async close() {
      if (closed) return;
      closed = true;
      await queue.shutdown();
      await app.close();
      if (writeLockFile) await removeLock(env);
    },
  };
}

interface RouteDeps {
  bus: EventBus;
  store: RunStore;
  queue: RunQueue;
  standbys: StandbyRegistry;
  prober: HarnessProber;
  config: () => LoadedConfig;
}

function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { bus, store, queue, standbys, prober, config } = deps;

  app.get("/health", async () => ({ ok: true, version: DAEMON_VERSION }));

  app.get("/stations", async () => describeStations(config(), prober));

  app.get("/runs", async (request) => {
    const limit = parseLimit(
      (request.query as Record<string, unknown>)["limit"],
    );
    const runs = await store.list(limit);
    return { runs };
  });

  app.get("/runs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    // Validated before it can reach the filesystem: a run id is a directory
    // name, so an unvalidated param is a path traversal.
    if (!isRunId(id))
      return reply.code(400).send({ error: "Malformed run id." });
    const stored = await store.get(id);
    if (!stored) return reply.code(404).send({ error: "No such run." });
    return stored;
  });

  app.post("/runs", async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "Body must be a JSON object." });
    }
    const { prompt, cuesheet } = body as Record<string, unknown>;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return reply.code(400).send({ error: "`prompt` is required." });
    }
    if (cuesheet !== undefined && typeof cuesheet !== "string") {
      return reply.code(400).send({ error: "`cuesheet` must be a string." });
    }

    const loaded = config();
    const sheet =
      cuesheet === undefined ? undefined : loaded.config.cuesheet[cuesheet];
    if (cuesheet !== undefined && sheet === undefined) {
      return reply
        .code(404)
        .send({ error: `No cuesheet named "${cuesheet}".` });
    }

    const stationIds = resolveStationIds(loaded, cuesheet);
    const workspace = resolveWorkspace(loaded, stationIds);

    const run = await queue.enqueue({
      prompt,
      workspace,
      ...(cuesheet !== undefined && { cuesheetId: cuesheet }),
      stationIds,
    });
    return reply.code(202).send({ runId: run.id });
  });

  app.post("/runs/:id/stop", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!isRunId(id))
      return reply.code(400).send({ error: "Malformed run id." });
    const outcome = await queue.stop(id);
    if (outcome === "not-found")
      return reply.code(404).send({ error: "No such run." });
    return { runId: id, outcome };
  });

  app.post("/standbys/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const body = request.body;
    const answer =
      body !== null && typeof body === "object"
        ? (body as Record<string, unknown>)["answer"]
        : undefined;
    if (answer !== "go" && answer !== "no") {
      return reply.code(400).send({ error: '`answer` must be "go" or "no".' });
    }
    const settled = standbys.resolve(id, answer);
    if (!settled) {
      return reply
        .code(404)
        .send({ error: "No standby is waiting on that id." });
    }
    return { standby: settled };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    // Attach is one synchronous call returning the backlog, so there is no
    // window between replaying buffered events and receiving live ones. See
    // the note at the top of `bus.ts` — this is where that matters.
    const { backlog, unsubscribe } = bus.attach((event) => send(event));

    function send(event: RunEvent): void {
      // A socket that closed between dispatch and write is normal, not an
      // error worth propagating into the bus.
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        unsubscribe();
      }
    }

    for (const event of backlog) send(event);
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}

/**
 * Which Stations a run involves.
 *
 * A named cuesheet contributes its cues in declared order; gate refs are
 * skipped because Gates are M5. A bare prompt uses the first configured
 * Station, which is the single-station case Milestone A is defined by.
 */
function resolveStationIds(loaded: LoadedConfig, cuesheet?: string): string[] {
  if (cuesheet !== undefined) {
    const sheet = loaded.config.cuesheet[cuesheet];
    if (sheet) {
      return sheet.cues
        .filter(
          (step): step is { station: string; action: string } =>
            "station" in step,
        )
        .map((step) => step.station);
    }
  }
  const first = loaded.config.station[0];
  return first ? [first.id] : [];
}

function resolveWorkspace(loaded: LoadedConfig, stationIds: string[]): string {
  for (const id of stationIds) {
    const station = loaded.config.station.find(
      (candidate) => candidate.id === id,
    );
    if (station?.workspace) return station.workspace;
  }
  return loaded.config.station.find((s) => s.workspace)?.workspace ?? "";
}

function parseLimit(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function addressPort(app: FastifyInstance): number | null {
  const [address] = app.addresses();
  return address && typeof address.port === "number" ? address.port : null;
}

/**
 * Whether a listen failure means "this port is not available to us".
 *
 * `EADDRINUSE` is the obvious case. `EACCES` is the Windows one: Hyper-V and
 * WSL reserve blocks of dynamic ports, and a bind inside a reserved range
 * fails with a permission error rather than an in-use error — on a machine
 * where 7373 happens to land in such a block, the honest message is still
 * "the port is unavailable", not a stack trace.
 */
function isPortUnavailable(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "EADDRINUSE" || code === "EACCES";
}
