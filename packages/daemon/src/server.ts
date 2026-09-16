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
import { stat } from "node:fs/promises";
import {
  addStation,
  ConfigError,
  createProjectRegistry,
  DEFAULT_PORT,
  expandHome,
  hostEnv,
  isProjectId,
  loadConfig,
  pathFor,
  ProjectRegistryError,
  resolveUserPath,
  stationIdTaken,
  type HostEnv,
  type LoadedConfig,
  type Project,
  type ProjectRegistry,
  type RunEvent,
} from "@cuesheet/core";
import { createEventBus, DEFAULT_REPLAY_LIMIT, type EventBus } from "./bus.js";
import { type RunDetailResponse, type RunStore } from "./store.js";
import { type RunExecutor } from "./executor.js";
import {
  createProjectRuntimes,
  type ProjectRuntime,
  type ProjectRuntimes,
} from "./projects.js";
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
  /**
   * Where to look for a legacy `cuesheet.toml` when the project registry is
   * empty. See the bootstrap note in {@link startDaemon}.
   *
   * No longer "where the config is": the daemon serves several projects and
   * has no single working directory that could mean the right thing.
   */
  cwd?: string;
  executor?: RunExecutor;
  /**
   * Build the executor once the config is loaded.
   *
   * An executor that runs real harnesses needs to resolve a Station id to its
   * `harness`, `model`, and leash, and the config is not read until after
   * `startDaemon` begins. A factory hands it the *live* accessor rather than a
   * snapshot, so `reloadConfig()` affects the next run instead of being
   * silently ignored — which is the bug you get from passing `loaded.config`
   * into a closure built at boot.
   *
   * Ignored when `executor` is given; tests pass the closure directly.
   */
  executorFactory?: (deps: ExecutorFactoryDeps) => RunExecutor;
  /**
   * Every project's run store. A test affordance — it only means anything
   * when one project is in play, because two projects sharing a store is the
   * exact thing this step exists to prevent. Use `storeFactory` otherwise.
   */
  store?: RunStore;
  /** Build a store per project. Defaults to files under the project's dir. */
  storeFactory?: (project: Project) => RunStore;
  /**
   * The project registry. Defaults to `~/.cuesheet/projects.json`.
   *
   * Named for what it holds rather than just `registry`, because
   * `harnessRuntime()` already spreads a `registry` of *harnesses* into these
   * options. Two different registries reaching one options object under one
   * name is a collision TypeScript happened to catch here and would not have
   * caught through a spread.
   */
  projectRegistry?: ProjectRegistry;
  bus?: EventBus;
  prober?: HarnessProber;
  replayLimit?: number;
  /** Off in tests, so a test run never clobbers a real daemon's lockfile. */
  writeLockFile?: boolean;
  /**
   * Mark runs left non-terminal by a crash as `interrupted` on boot. On by
   * default — it is a correctness guarantee, not a feature — and off only for
   * tests that want to assert on an unreconciled store.
   */
  reconcile?: boolean;
  logger?: boolean;
}

export interface ExecutorFactoryDeps {
  /** Reads the currently loaded config. Call per run, never cache the result. */
  config: () => LoadedConfig;
  env: HostEnv;
}

export interface DaemonHandle {
  /** The port actually bound, which is what matters when `port` was `0`. */
  port: number;
  host: string;
  url: string;
  app: FastifyInstance;
  /**
   * Every project's events, interleaved.
   *
   * **Not a per-project backlog.** Each project has its own bus and mirrors
   * into this one, so `attach()`'s replay here contains other projects' events
   * too. That is exactly what the desktop shell wants — one subscription,
   * notify on any standby — and exactly what a client rendering one project
   * must not read. Those attach to `GET /projects/:id/ws` instead.
   */
  bus: EventBus;
  standbys: StandbyRegistry;
  registry: ProjectRegistry;
  projects: ProjectRuntimes;
  /**
   * The project the daemon bootstrapped at boot, or `null` on a fresh install
   * with no config anywhere.
   *
   * A convenience for programmatic callers and tests, not an "active project":
   * it never changes for the life of the process, and the HTTP API — which is
   * the contract every client actually uses — has no such concept. Which
   * project a client is looking at is the client's business, which is what
   * makes switching in Step 34 a client action that cannot disturb a run.
   */
  defaultProject: ProjectRuntime | null;
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
  const reconcile = options.reconcile ?? true;

  const bus =
    options.bus ??
    createEventBus({
      replayLimit: options.replayLimit ?? DEFAULT_REPLAY_LIMIT,
    });
  const standbys = createStandbyRegistry();
  const prober = options.prober ?? unprobed;
  const registry = options.projectRegistry ?? createProjectRegistry({ env });

  const runtimes = createProjectRuntimes({
    registry,
    env,
    globalBus: bus,
    standbys,
    reconcile,
    ...(options.replayLimit !== undefined && {
      replayLimit: options.replayLimit,
    }),
    ...(options.executor && { executor: options.executor }),
    ...(options.executorFactory && {
      executorFactory: options.executorFactory,
    }),
    // A single injected store means "use this for every project". Honest only
    // with one project, which is what every caller passing it has.
    ...(options.store
      ? { storeFactory: () => options.store as RunStore }
      : options.storeFactory
        ? { storeFactory: options.storeFactory }
        : {}),
  });

  const defaultProject = await bootstrapProject({
    registry,
    runtimes,
    cwd,
    env,
  });

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

  const routeDeps: RouteDeps = {
    standbys,
    prober,
    env,
    registry,
    runtimes,
  };

  registerRoutes(app, routeDeps);
  // The same routes under `/api` as well, because Step 17's Vite dev server
  // proxies `/api` and `/ws`. One registration with a prefix beats a rewrite
  // rule in the dev config and keeps `curl :7373/health` working.
  await app.register(
    async (scope) => {
      registerRoutes(scope, routeDeps);
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

  // Reconciliation used to happen here, once, for the one store there was.
  // It now happens inside `createProjectRuntimes` when a project is first
  // touched — still before anything can observe an unreconciled run, and
  // O(projects actually opened) rather than O(every project ever registered)
  // on every boot. The safety argument in `reconcile.ts` is unchanged; only
  // the moment it is discharged has moved.

  let closed = false;
  return {
    port: boundPort,
    host,
    url: `http://${host}:${boundPort}`,
    app,
    bus,
    standbys,
    registry,
    projects: runtimes,
    defaultProject,
    async close() {
      if (closed) return;
      closed = true;
      await runtimes.closeAll();
      await app.close();
      if (writeLockFile) await removeLock(env);
    },
  };
}

/**
 * Give an existing install its project back.
 *
 * Bootstrapped from **the config that exists**, never from `cwd`. That
 * distinction is the whole point: in the packaged app `process.cwd()` is
 * whatever the OS handed the process — `/` on macOS from Finder — and opening
 * it would mint a permanent registry entry rooted at the filesystem root, on
 * exactly the platform being shipped. `loadConfig` already knows how to find
 * the config that a pre-projects Cuesheet was using, so its `sourcePath` is
 * the honest answer to "which folder was this person working in".
 *
 * Nothing is bootstrapped when there is no config anywhere: a fresh install
 * has no projects, `GET /projects` answers `[]`, and the launch surface of
 * Step 40 is what asks. Inventing a project for someone who has never had one
 * would put a folder in their picker that they did not choose.
 *
 * **This is a seam for Step 33, not the migration.** A user whose config is
 * the global `~/.cuesheet/cuesheet.toml` gets a project rooted at
 * `~/.cuesheet`, which is not where their code is — and their existing run
 * history under `~/.cuesheet/runs` is not moved here at all. Both are Step
 * 33's job, which is the step that owns "the upgrade that loses nothing".
 */
async function bootstrapProject(deps: {
  registry: ProjectRegistry;
  runtimes: ProjectRuntimes;
  cwd: string;
  env: HostEnv;
}): Promise<ProjectRuntime | null> {
  const { registry, runtimes, cwd, env } = deps;

  const known = await registry.list();
  const existing = known.find((project) => project.status === "ok");
  if (existing) return runtimes.get(existing.id);
  // Every known project's folder is gone. Opening a new one on top would be a
  // surprise; the picker says `missing` and the operator decides.
  if (known.length > 0) return null;

  const legacy = await loadConfig(cwd, env);
  if (legacy.sourcePath === null) return null;

  const root = pathFor(env).dirname(legacy.sourcePath);
  try {
    const project = await registry.open(root);
    return await runtimes.get(project.id);
  } catch (error) {
    // A config in a folder that cannot be opened is not a reason to refuse to
    // boot: the daemon still serves `/projects`, and the operator can pick.
    if (error instanceof ProjectRegistryError) return null;
    throw error;
  }
}

interface RouteDeps {
  standbys: StandbyRegistry;
  prober: HarnessProber;
  env: HostEnv;
  registry: ProjectRegistry;
  runtimes: ProjectRuntimes;
}

/**
 * The route surface, now project-scoped.
 *
 * `/runs` and `/stations` used to sit at the top level, which was only
 * coherent while there was exactly one of everything. They are now under
 * `/projects/:id/`, and the cutover is deliberate rather than aliased: a
 * compatibility route would have to mean "the active project", and a
 * daemon-side active project is precisely the concept Phase 8 decided against.
 * Which project a client is looking at is the client's business — that is what
 * lets Step 34 switch projects without disturbing a run.
 *
 * Two routes stay global on purpose. `/health` is about the process. And
 * `/standbys/:id` is about one question waiting for one answer: standby ids
 * are unique daemon-wide because the registry is shared by every runtime, and
 * a phone answering a standby should not have to know which project raised it.
 */
function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { standbys, prober, env, registry, runtimes } = deps;

  app.get("/health", async () => ({ ok: true, version: DAEMON_VERSION }));

  // ── Projects ──────────────────────────────────────────────────────────────

  /**
   * Answers on a fresh install, before any project has ever been opened, with
   * an empty list rather than an error. The picker's first render depends on
   * it.
   */
  app.get("/projects", async () => ({ projects: await registry.list() }));

  app.post("/projects", async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "Body must be a JSON object." });
    }
    const { root, name } = body as Record<string, unknown>;
    if (typeof root !== "string" || root.trim() === "") {
      return reply.code(400).send({ error: "`root` is required." });
    }
    if (name !== undefined && typeof name !== "string") {
      return reply.code(400).send({ error: "`name` must be a string." });
    }
    try {
      const project = await registry.open(
        resolveUserPath(expandHome(root, env), process.cwd()),
        { ...(name !== undefined && { name }) },
      );
      return reply.code(201).send({ project });
    } catch (error) {
      // A folder that is not there is the mistake a person actually makes, and
      // the registry's message already says which path it was.
      if (error instanceof ProjectRegistryError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/projects/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!isProjectId(id))
      return reply.code(400).send({ error: "Malformed project id." });
    const project = await registry.get(id);
    if (!project) return reply.code(404).send({ error: "No such project." });
    return { project };
  });

  app.delete("/projects/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!isProjectId(id))
      return reply.code(400).send({ error: "Malformed project id." });
    // Forgets the entry; never touches the folder or its run records. A
    // project removed from the picker and then reopened keeps its history.
    const existed = await registry.forget(id);
    if (!existed) return reply.code(404).send({ error: "No such project." });
    return { forgotten: id };
  });

  /**
   * Resolve `:id` to a live runtime, or answer and return `null`.
   *
   * The id is validated before anything uses it, because it becomes a
   * directory name under `~/.cuesheet/projects` — `projectDir()` throws on a
   * bad one, and a 400 here is a better answer than a 500 from deeper in.
   */
  async function runtimeFor(
    request: { params: unknown },
    reply: {
      code(status: number): { send(body: unknown): unknown };
    },
  ): Promise<ProjectRuntime | null> {
    const id = (request.params as { id: string }).id;
    if (!isProjectId(id)) {
      reply.code(400).send({ error: "Malformed project id." });
      return null;
    }
    const runtime = await runtimes.get(id);
    if (!runtime) {
      reply.code(404).send({ error: "No such project." });
      return null;
    }
    return runtime;
  }

  // ── Stations, per project ────────────────────────────────────────────────

  app.get("/projects/:id/stations", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    return describeStations(runtime.config(), prober);
  });

  /**
   * Add a Station — Step 20's panel, server side.
   *
   * Writes to this project's `cuesheet.toml` and then reloads, so the response
   * already reflects the new tile and the next run can resolve the Station.
   * When the project has no config yet, one is created under
   * `~/.cuesheet/projects/<id>/` rather than in the single global file — which
   * before Step 32 is where a second project's first Station would silently
   * have landed, editing the first project's config.
   */
  app.post("/projects/:id/stations", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;

    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "Body must be a JSON object." });
    }
    const draft = body as Record<string, unknown>;

    const id = draft["id"];
    if (typeof id === "string" && stationIdTaken(runtime.config(), id)) {
      // 409 rather than the loader's "the last one wins" warning. That reading
      // is fine for a file a human hand-edited; it is not a defensible outcome
      // for a button, where the user would silently shadow an existing tile.
      return reply.code(409).send({
        error: `A station named "${id}" is already configured.`,
      });
    }

    const workspace = draft["workspace"];
    if (workspace !== undefined) {
      if (typeof workspace !== "string" || workspace.trim() === "") {
        return reply
          .code(400)
          .send({ error: "`workspace` must be a non-empty string." });
      }
      const problem = await workspaceProblem(workspace, env);
      if (problem) return reply.code(400).send({ error: problem });
    }

    try {
      const result = await addStation(draft, {
        sourcePath: runtime.config().sourcePath,
        fallbackPath: runtime.configFallbackPath,
        env,
      });
      // Reload before responding, so the caller never sees a Station it then
      // cannot run. `describeStations` is re-derived from the fresh config.
      const reloaded = await runtime.reload();
      const stations = await describeStations(reloaded, prober);
      return reply.code(201).send({
        station: result.station,
        sourcePath: result.sourcePath,
        created: result.created,
        stations,
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  // ── Runs, per project ────────────────────────────────────────────────────

  app.get("/projects/:id/runs", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    const limit = parseLimit(
      (request.query as Record<string, unknown>)["limit"],
    );
    const runs = await runtime.store.list(limit);
    return { runs };
  });

  app.get("/projects/:id/runs/:runId", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    const runId = (request.params as { runId: string }).runId;
    // Validated before it can reach the filesystem: a run id is a directory
    // name, so an unvalidated param is a path traversal.
    if (!isRunId(runId))
      return reply.code(400).send({ error: "Malformed run id." });
    const stored = await runtime.store.get(runId);
    if (!stored) return reply.code(404).send({ error: "No such run." });

    // The patch is deliberately *not* in this response. A run against a
    // workspace with a large untracked tree produces a diff measured in
    // megabytes, and this route is what the Desk calls to open a run row.
    // `hasDiff` is enough to decide whether to offer the button; the bytes
    // come from `/runs/:runId/diff` when someone actually asks for them.
    const { diff, ...rest } = stored;
    const detail: RunDetailResponse = { ...rest, hasDiff: diff !== undefined };
    return detail;
  });

  /**
   * The patch itself, as text.
   *
   * `text/plain` rather than JSON: a unified diff is a document, and wrapping
   * megabytes of it in a JSON string means escaping every newline on the way
   * out and unescaping them on the way in, for nothing.
   */
  app.get("/projects/:id/runs/:runId/diff", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    const runId = (request.params as { runId: string }).runId;
    if (!isRunId(runId))
      return reply.code(400).send({ error: "Malformed run id." });
    const diff = await runtime.store.getDiff(runId);
    if (diff === null) {
      return reply.code(404).send({ error: "That run has no diff." });
    }
    return reply.type("text/plain; charset=utf-8").send(diff);
  });

  app.post("/projects/:id/runs", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;

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

    const loaded = runtime.config();
    const sheet =
      cuesheet === undefined ? undefined : loaded.config.cuesheet[cuesheet];
    if (cuesheet !== undefined && sheet === undefined) {
      return reply
        .code(404)
        .send({ error: `No cuesheet named "${cuesheet}".` });
    }

    const stationIds = resolveStationIds(loaded, cuesheet);
    const workspace = resolveWorkspace(loaded, stationIds);

    const run = await runtime.queue.enqueue({
      prompt,
      workspace,
      ...(cuesheet !== undefined && { cuesheetId: cuesheet }),
      stationIds,
    });
    return reply.code(202).send({ runId: run.id });
  });

  app.post("/projects/:id/runs/:runId/stop", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    const runId = (request.params as { runId: string }).runId;
    if (!isRunId(runId))
      return reply.code(400).send({ error: "Malformed run id." });
    const outcome = await runtime.queue.stop(runId);
    if (outcome === "not-found")
      return reply.code(404).send({ error: "No such run." });
    return { runId, outcome };
  });

  // ── Global ───────────────────────────────────────────────────────────────

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

  /**
   * One project's event stream.
   *
   * Scoped by attaching to that project's own bus rather than by filtering a
   * shared one, which is what makes the backlog correct as well as the live
   * feed: `attach()` returns the replay synchronously so there is no window
   * between buffered and live events (see the note at the top of `bus.ts`),
   * and a filtered global backlog would have to drop events it could not
   * attribute.
   */
  app.get("/projects/:id/ws", { websocket: true }, (socket, request) => {
    const id = (request.params as { id: string }).id;
    if (!isProjectId(id)) {
      socket.close(1008, "Malformed project id.");
      return;
    }
    void runtimes.get(id).then((runtime) => {
      if (!runtime) {
        socket.close(1008, "No such project.");
        return;
      }
      if (socket.readyState !== socket.OPEN) return;
      const { backlog, unsubscribe } = runtime.bus.attach((event) =>
        send(event),
      );

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

/**
 * Why a workspace path is unusable, or `null` if it is fine.
 *
 * `~/code/api` is the path a person types and the README's own example, and
 * Windows will not expand it for you — so expand first, then resolve, then
 * stat. Checking the raw string would reject a perfectly good tilde path.
 */
async function workspaceProblem(
  workspace: string,
  env: HostEnv,
): Promise<string | null> {
  const resolved = resolveUserPath(expandHome(workspace, env), process.cwd());
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      return `Workspace ${resolved} is not a directory.`;
    }
    return null;
  } catch {
    return `Workspace ${resolved} does not exist.`;
  }
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
