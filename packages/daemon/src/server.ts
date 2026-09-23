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
import type { ContextFile } from "@cuesheet/harness";
import type { Connector } from "@cuesheet/harness";
import {
  addStation,
  buildLedger,
  isFactId,
  slugify,
  cappedHarnesses,
  checkLimits,
  chooseFallback,
  ConfigError,
  configFile,
  createProjectRegistry,
  DEFAULT_PORT,
  expandHome,
  hostEnv,
  isProjectId,
  legacyProjectRoot,
  loadConfig,
  migrateLegacyConfig,
  migrateLegacyRuns,
  ProjectRegistryError,
  resolveUserPath,
  runsDir,
  stationIdTaken,
  type HostEnv,
  type Fact,
  type LoadedConfig,
  type Project,
  type ProjectRegistry,
  type RunEvent,
} from "@cuesheet/core";
import { createEventBus, DEFAULT_REPLAY_LIMIT, type EventBus } from "./bus.js";
import { type RunDetailResponse, type RunStore } from "./store.js";
import type { RunStoreBackend } from "./store-backend.js";
import { type RunExecutor } from "./executor.js";
import {
  createProjectRuntimes,
  type ProjectRuntime,
  type ProjectRuntimes,
} from "./projects.js";
import { createStandbyRegistry, type StandbyRegistry } from "./standby.js";
import {
  describeStations,
  unknownConfinement,
  unknownRoles,
  unprobed,
  type HarnessProber,
  type HarnessConfinement,
  type HarnessRoles,
  builtinHarnesses,
  type KnownHarnesses,
} from "./stations.js";
import {
  createUsageCache,
  type UsageCache,
  type UsageSource,
} from "./usage.js";
import {
  createCommonsStore,
  CommonsError,
  CommonsSyncError,
  type CommonsStore,
} from "./commons.js";
import {
  createCommonsInbox,
  CommonsInboxError,
  type CommonsInbox,
} from "./commons-inbox.js";
import { isRunId } from "./ids.js";
import {
  createCommonsProjector,
  type CommonsProjector,
} from "./projections.js";
import { createCommonsMcpHandler, type MemoryWriteInput } from "./mcp.js";
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
  /** Build a store per project. Defaults to the project's own `runs.db`. */
  storeFactory?: (project: Project) => RunStore | Promise<RunStore>;
  /**
   * `sqlite` (the default) or `files`. Read from `CUESHEET_RUN_STORE` when
   * absent; see `store-backend.ts` for why this is an installation-level
   * choice rather than a config table.
   */
  storeBackend?: RunStoreBackend;
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
  /**
   * What each harness can be. Supplied by `harnessRuntime()` from the
   * registry; left unknown here so `startDaemon`'s own tests do not have to
   * carry a registry to avoid warnings about seats they never configured.
   */
  harnessRoles?: HarnessRoles;
  /** What each harness's own sandbox does with a seat. See `stations.ts`. */
  harnessConfinement?: HarnessConfinement;
  /**
   * Which harnesses this build registered. Supplied by `harnessRuntime()`.
   *
   * Defaults to `BUILTIN_HARNESS_IDS`, which is what `startDaemon`'s own
   * tests want: a fixed list that does not change with what somebody has
   * installed. See {@link KnownHarnesses} for why the default is not enough
   * for the app.
   */
  knownHarnesses?: KnownHarnesses;
  /**
   * The harnesses `GET /usage` reads. Supplied by `harnessRuntime()`; empty
   * here, so `startDaemon`'s own tests never wait on somebody's CLI.
   */
  usageSources?: () => readonly UsageSource[];
  /** The Commons. Defaults to `~/.cuesheet/commons` under `env`'s homedir. */
  commons?: CommonsStore;
  /** Pending agent captures. Defaults outside the Git-backed Commons store. */
  commonsInbox?: CommonsInbox;
  /** Context targets declared by the registered harnesses. */
  contextFiles?: () => readonly ContextFile[];
  /** Register daemon-owned MCP servers in the installed harness runtimes. */
  writeConnectors?: (connectors: readonly Connector[]) => Promise<void>;
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
  /** The project this executor belongs to; there is no daemon-wide active one. */
  projectId: string;
  /** User facts plus facts tagged for this project, read at run time. */
  memoryFacts: () => Promise<Fact[]>;
  /**
   * Which harnesses are at or past `block_at` right now.
   *
   * Supplied by the daemon rather than assembled in `harnessRuntime()`, because
   * the usage cache is built here and the thresholds come from the *project's*
   * config — two things a harness registry has no business knowing about.
   *
   * Optional so that `projects.ts`, which is what actually calls the factory,
   * does not have to carry a usage cache through a file about project
   * lifetimes. `startDaemon` wraps the caller's factory to supply it; absent
   * means nothing is capped, which is the right answer for a library caller
   * who wired no usage sources.
   */
  capped?: () => Promise<readonly string[]>;
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
  const harnessRoles = options.harnessRoles ?? unknownRoles;
  const harnessConfinement = options.harnessConfinement ?? unknownConfinement;
  const knownHarnesses = options.knownHarnesses ?? builtinHarnesses;
  const usage = createUsageCache({
    sources: options.usageSources ?? (() => []),
  });
  const commons = options.commons ?? createCommonsStore({ env });
  const commonsInbox = options.commonsInbox ?? createCommonsInbox({ env });

  // A finished run is the one moment plan usage actually moves — `claude-code`
  // learns its limits only from inside a run, so its answer changes exactly
  // here and nowhere else. Dropping the cache means the next `GET /usage`
  // re-reads instead of serving a window from before the run that consumed it.
  //
  // On the daemon-wide bus rather than per project, deliberately: usage is a
  // property of a plan, and a run in *any* project spends the same one.
  bus.attach((event) => {
    if (event.t === "done") usage.clear();
  });
  const registry = options.projectRegistry ?? createProjectRegistry({ env });
  const projector = createCommonsProjector({
    store: commons,
    registry,
    env,
    contextFiles: options.contextFiles ?? (() => []),
  });

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
    // Wrapped rather than passed through: the factory's caller wants a
    // `capped` it has no way to build, and `projects.ts` has no business
    // holding a usage cache. `deps.config()` is read at run time, so a project
    // whose thresholds were edited mid-session routes on the new ones.
    ...(options.executorFactory && {
      executorFactory: (deps: ExecutorFactoryDeps) =>
        (options.executorFactory as (d: ExecutorFactoryDeps) => RunExecutor)({
          ...deps,
          memoryFacts: async () =>
            (await commons.list()).filter(
              (fact) =>
                fact.projects.length === 0 ||
                fact.projects.includes(deps.projectId),
            ),
          capped: async () =>
            cappedHarnesses(
              (await usage.get()).harnesses,
              deps.config().config.limits,
            ),
        }),
    }),
    ...(options.storeBackend !== undefined && {
      storeBackend: options.storeBackend,
    }),
    // A single injected store means "use this for every project". Honest only
    // with one project, which is what every caller passing it has.
    ...(options.store
      ? { storeFactory: () => options.store as RunStore }
      : options.storeFactory
        ? { storeFactory: options.storeFactory }
        : {}),
  });

  const bootstrapped = await bootstrapProject({
    registry,
    runtimes,
    cwd,
    env,
  });
  const defaultProject = bootstrapped.runtime;

  const app = Fastify({ logger: options.logger ?? false });

  // Files can change while Cuesheet is not running. Regenerating at boot is
  // the cheap reconciliation point that makes the store the source of truth
  // without introducing a filesystem watcher. A malformed marker must not
  // make the whole daemon unavailable; the next explicit Commons write still
  // reports the projection failure to its caller.
  try {
    await projector.regenerate();
  } catch (error) {
    app.log.error(
      `Could not regenerate Commons projections: ${errorText(error)}`,
    );
  }

  // Logged here rather than inside `bootstrapProject`, which runs before there
  // is a logger to log to — and the migration has to finish before any runtime
  // is built, so it cannot simply be moved down.
  for (const note of bootstrapped.notes) app.log.info(note);
  for (const problem of bootstrapped.problems) app.log.error(problem);

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
    harnessRoles,
    harnessConfinement,
    knownHarnesses,
    usage,
    commons,
    commonsInbox,
    projector,
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

  // The endpoint has to be listening before a CLI health-checks it during
  // `mcp add`. Registration failures degrade recall rather than taking the
  // daemon down; the ordinary context-file projections still work.
  if (options.writeConnectors) {
    try {
      await options.writeConnectors([
        { name: "cuesheet-commons", url: `http://${host}:${boundPort}/mcp` },
      ]);
    } catch (error) {
      app.log.warn(`Could not register Commons MCP: ${errorText(error)}`);
    }
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
 * Give an existing install its project back — and, on the first boot of a build
 * that has projects, bring the whole of an alpha profile forward with it.
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
 * **Step 33 changed two things here and deliberately not a third.** The root
 * now comes from {@link legacyProjectRoot} rather than being `dirname` of the
 * config, so a user whose only config was the global one lands on their code
 * instead of on `~/.cuesheet`; and the legacy config and run history are
 * relocated, in that order, **before any runtime is built**. What did not
 * change is which project the daemon comes up on — still the most recently
 * opened one that is still there. Step 32's retrospective asked for exactly
 * that, because `server.test.ts` alone hangs 41 call sites off `defaultProject`
 * and a migration that re-based them would be proving something else.
 *
 * The ordering is not incidental. `runtimes.get` reconciles a project's store
 * the first time it is touched, and reconciliation happens exactly once; moving
 * the history in afterwards would leave every alpha run that a killed daemon
 * left `running` marked `running` with nothing left to correct it.
 */
async function bootstrapProject(deps: {
  registry: ProjectRegistry;
  runtimes: ProjectRuntimes;
  cwd: string;
  env: HostEnv;
}): Promise<BootstrapReport> {
  const { registry, runtimes, cwd, env } = deps;
  const report: BootstrapReport = { runtime: null, notes: [], problems: [] };

  const known = await registry.list();
  const existing = known.find((project) => project.status === "ok");
  if (existing) {
    // A retry, not a second migration. The move below is guarded on its target
    // being absent, so in the ordinary case this is one `stat` that returns
    // ENOENT forever after. It exists because a failed move registers nothing:
    // without this the first boot would be the only chance, and a history left
    // behind by a transient error would be orphaned permanently.
    //
    // **Only while there is exactly one project.** Legacy runs belong to the
    // install, not to a folder, and with one project that is unambiguous. With
    // two, the daemon would be picking which one inherits a history that names
    // neither, so it leaves them alone rather than attributing them wrongly.
    if (known.length === 1) await relocateRuns(existing.id, env, report);
    report.runtime = await runtimes.get(existing.id);
    return report;
  }
  // Every known project's folder is gone. Opening a new one on top would be a
  // surprise; the picker says `missing` and the operator decides.
  if (known.length > 0) return report;

  const legacy = await loadConfig(cwd, env);
  const root = await legacyProjectRoot(legacy, env);
  if (root === null) return report;

  let project: Project;
  try {
    project = await registry.open(root);
  } catch (error) {
    // A config in a folder that cannot be opened is not a reason to refuse to
    // boot: the daemon still serves `/projects`, and the operator can pick.
    if (error instanceof ProjectRegistryError) return report;
    throw error;
  }

  // Config first, then runs, then the runtime. Config first only because it is
  // the move that decides whether the Desk has any Stations at all — if exactly
  // one of the two is going to fail, the operator is better served by the
  // failure they can see.
  try {
    const moved = await migrateLegacyConfig({
      projectId: project.id,
      root,
      sourcePath: legacy.sourcePath,
      env,
    });
    if (moved) {
      report.notes.push(
        `Upgraded: moved ${moved.from} to ${moved.to} for project "${project.name}".`,
      );
    }
  } catch (error) {
    // Nothing is lost — the config is still where it was — but this project
    // will come up on defaults until the move succeeds, so it is an error and
    // not a note.
    report.problems.push(
      `Could not move the existing ${configFile(env)} into project "${project.name}": ` +
        `${errorText(error)}. It has not been changed.`,
    );
  }

  await relocateRuns(project.id, env, report);
  report.runtime = await runtimes.get(project.id);
  return report;
}

/** What `startDaemon` needs back: the project to serve, and what to log. */
interface BootstrapReport {
  runtime: ProjectRuntime | null;
  notes: string[];
  problems: string[];
}

/**
 * One call site's worth of the run-history move, shared by the mint path and
 * the retry above so the two cannot drift into disagreeing about the guards.
 *
 * A failure here is survivable in a way the config's is not: the history is
 * still at `~/.cuesheet/runs`, the target is still absent, and the next boot
 * arrives back at this same call. So the daemon boots, says so, and tries
 * again — rather than refusing to start over a directory rename.
 */
async function relocateRuns(
  projectId: string,
  env: HostEnv,
  report: BootstrapReport,
): Promise<void> {
  try {
    const moved = await migrateLegacyRuns({ projectId, env });
    if (moved) {
      report.notes.push(
        `Upgraded: moved run history from ${moved.from} to ${moved.to}.`,
      );
    }
  } catch (error) {
    report.problems.push(
      `Could not move the existing run history at ${runsDir(env)}: ${errorText(error)}. ` +
        `Nothing has been deleted, and this will be retried on the next start.`,
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RouteDeps {
  standbys: StandbyRegistry;
  prober: HarnessProber;
  harnessRoles: HarnessRoles;
  harnessConfinement: HarnessConfinement;
  knownHarnesses: KnownHarnesses;
  usage: UsageCache;
  commons: CommonsStore;
  commonsInbox: CommonsInbox;
  projector: CommonsProjector;
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
  const {
    standbys,
    prober,
    harnessRoles,
    harnessConfinement,
    knownHarnesses,
    usage,
    commons,
    commonsInbox,
    projector,
    env,
    registry,
    runtimes,
  } = deps;

  app.get("/health", async () => ({ ok: true, version: DAEMON_VERSION }));

  /**
   * Plan usage — **global, not per project**, and the exception is worth a
   * line because Step 38 renders this strip *inside* a project and the next
   * reader will assume the route should have matched.
   *
   * A five-hour window belongs to a plan, and a plan belongs to a vendor. It
   * is the same window whichever repository you are standing in, and serving
   * it per project would invite a client to add up four projects' copies of
   * one budget. Which project is spending it is the strip's question to
   * answer, not this route's.
   */
  app.get("/usage", async () => usage.get());

  // ── The Commons ───────────────────────────────────────────────────────────

  const mcp = createCommonsMcpHandler({
    store: commons,
    capture: captureMemory,
  });

  app.post("/mcp", async (request, reply) => {
    // The official transport owns the raw response, including whether it is a
    // JSON response or an SSE stream. Fastify must not serialize a second one.
    reply.hijack();
    try {
      await mcp.handle(request.raw, reply.raw, request.body);
    } catch (error) {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "content-type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: errorText(error) },
          }),
        );
      }
    }
  });
  app.get("/mcp", async (_request, reply) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Method not allowed." },
      }),
  );
  app.delete("/mcp", async (_request, reply) =>
    reply
      .code(405)
      .header("allow", "POST")
      .send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Method not allowed." },
      }),
  );

  /**
   * **Global, like `/usage` and for a related reason.** The store is one
   * repository at `~/.cuesheet/commons`; what varies per project is which
   * facts *project into* it, which is Step 47's subject and rides on a fact's
   * own `projects` field rather than on the route.
   */
  app.get("/commons", async () => ({ facts: await commons.list() }));

  /**
   * Pending captures are global because there is one inbox. Each item carries
   * its project ids, so the Desk can filter without inventing daemon-side
   * "current project" state.
   */
  app.get("/commons/inbox", async () => ({
    pending: await commonsInbox.list(),
  }));

  app.post("/commons/inbox/:id/approve", async (request, reply) => {
    const pendingId = (request.params as { id: string }).id;
    if (!isFactId(pendingId)) {
      return reply.code(400).send({ error: "Malformed pending memory id." });
    }
    const edits = objectBody(request.body);
    if (edits === null) {
      return reply.code(400).send({ error: "Body must be a JSON object." });
    }

    try {
      const approved = await commonsInbox.resolve(pendingId, async (memory) => {
        const title = stringEdit(edits, "title", memory.title);
        const text = stringEdit(edits, "body", memory.body, false);
        const tags = stringArrayEdit(edits, "tags", memory.tags);
        const projects = stringArrayEdit(edits, "projects", memory.projects);
        const requestedId = edits["id"];
        const factId =
          requestedId === undefined
            ? (memory.suggestedId ?? slugify(title))
            : typeof requestedId === "string"
              ? requestedId
              : null;
        if (!isFactId(factId)) {
          throw new CommonsInboxError(
            "`id` must be lowercase letters, digits and single hyphens.",
          );
        }
        if ((await commons.get(factId)) !== null) {
          throw new CommonsConflictError(
            `A Commons fact named "${factId}" already exists. Edit the id before approving.`,
          );
        }
        const written = await commons.write({
          id: factId,
          title,
          body: text,
          tags,
          projects,
          ...(memory.provenance.station !== undefined && {
            station: memory.provenance.station,
          }),
          ...(memory.provenance.run !== undefined && {
            run: memory.provenance.run,
          }),
          at: memory.provenance.at,
        });
        await projector.regenerate();
        return written;
      });
      if (approved === null) {
        return reply.code(404).send({ error: "No such pending memory." });
      }
      return approved;
    } catch (error) {
      if (error instanceof CommonsConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof CommonsInboxError || error instanceof CommonsError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete("/commons/inbox/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!isFactId(id)) {
      return reply.code(400).send({ error: "Malformed pending memory id." });
    }
    const discarded = await commonsInbox.discard(id);
    if (discarded === null) {
      return reply.code(404).send({ error: "No such pending memory." });
    }
    return { discarded };
  });

  app.get("/commons/history", async (request) => {
    const limit = parseLimit(
      (request.query as Record<string, unknown>)["limit"],
    );
    // The whole shape, `reason` included: "history is unavailable" and
    // "nothing has happened yet" are different answers.
    return commons.history(limit);
  });

  /**
   * Sync is global for the same reason the Commons itself is global. The
   * remote lives in the repository's own `.git/config`; putting it in one
   * project's `cuesheet.toml` would let whichever project loaded last redefine
   * where every other project's memory is pushed.
   */
  app.get("/commons/sync", async (_request, reply) => {
    try {
      return await commons.syncStatus();
    } catch (error) {
      if (error instanceof CommonsSyncError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.put("/commons/sync", async (request, reply) => {
    const body = objectBody(request.body);
    if (body === null || typeof body["remote"] !== "string") {
      return reply.code(400).send({ error: "`remote` is required." });
    }
    try {
      return await commons.configureSync(body["remote"]);
    } catch (error) {
      if (error instanceof CommonsSyncError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/commons/sync/pull", async (_request, reply) => {
    try {
      const result = await commons.pull();
      if (result.outcome !== "conflict") await projector.regenerate();
      return result;
    } catch (error) {
      if (error instanceof CommonsSyncError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/commons/sync/push", async (_request, reply) => {
    try {
      return await commons.push();
    } catch (error) {
      if (error instanceof CommonsSyncError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post("/commons/sync/continue", async (_request, reply) => {
    try {
      const result = await commons.continueSync();
      if (result.outcome === "resolved") await projector.regenerate();
      return result;
    } catch (error) {
      if (error instanceof CommonsSyncError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/commons/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    // Validated before it reaches the filesystem. A fact id is a filename, so
    // an unvalidated param is a path traversal — the rule run ids already
    // carry, for the same reason.
    if (!isFactId(id)) {
      return reply.code(400).send({ error: "Malformed fact id." });
    }
    const fact = await commons.get(id);
    if (fact === null) return reply.code(404).send({ error: "No such fact." });
    return { fact };
  });

  app.post("/commons", async (request, reply) => {
    const body = request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply.code(400).send({ error: "Body must be a JSON object." });
    }
    const {
      id,
      title,
      body: text,
      tags,
      projects,
      station,
      run,
    } = body as Record<string, unknown>;

    if (typeof title !== "string" || title.trim() === "") {
      return reply.code(400).send({ error: "`title` is required." });
    }
    if (typeof text !== "string") {
      return reply.code(400).send({ error: "`body` is required." });
    }
    if (id !== undefined && !isFactId(id)) {
      return reply.code(400).send({
        error:
          "`id` must be lowercase letters, digits and single hyphens — it is " +
          "a filename.",
      });
    }

    try {
      const written = await commons.write({
        ...(typeof id === "string" && { id }),
        title,
        body: text,
        ...(Array.isArray(tags) && { tags: onlyStrings(tags) }),
        ...(Array.isArray(projects) && { projects: onlyStrings(projects) }),
        ...(typeof station === "string" && { station }),
        ...(typeof run === "string" && { run }),
      });
      await projector.regenerate();
      // The whole write, not a bare 201: a fact written but *not* recorded in
      // history is a different outcome from one that was, and a client that
      // cannot tell them apart will imply a history that is not there.
      return reply.code(201).send(written);
    } catch (error) {
      if (error instanceof CommonsError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.delete("/commons/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!isFactId(id)) {
      return reply.code(400).send({ error: "Malformed fact id." });
    }
    const removed = await commons.remove(id);
    if (removed === null) {
      return reply.code(404).send({ error: "No such fact." });
    }
    await projector.regenerate();
    return removed;
  });

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
      await projector.regenerate();
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

  async function captureMemory(input: MemoryWriteInput): Promise<unknown> {
    if (!isProjectId(input.project)) {
      throw new MemoryCaptureError(400, "`project` is not a project id.");
    }
    const runtime = await runtimes.get(input.project);
    if (!runtime) throw new MemoryCaptureError(404, "No such project.");
    if (!isRunId(input.run)) {
      throw new MemoryCaptureError(400, "`run` is not a run id.");
    }
    if ((await runtime.store.get(input.run)) === null) {
      throw new MemoryCaptureError(404, "The source run does not exist.");
    }
    if (
      !runtime
        .config()
        .config.station.some((candidate) => candidate.id === input.station)
    ) {
      throw new MemoryCaptureError(
        400,
        `Station "${input.station}" is not configured for this project.`,
      );
    }

    const write = {
      title: input.title,
      body: input.body,
      tags: input.tags,
      projects: [runtime.project.id],
      station: input.station,
      run: input.run,
    };
    if (runtime.config().config.commons.approval === "auto") {
      try {
        const written = await commons.write(write);
        await projector.regenerate();
        return { status: "approved", ...written };
      } catch (error) {
        if (error instanceof CommonsError) {
          throw new MemoryCaptureError(400, error.message);
        }
        throw error;
      }
    }

    const memory = await commonsInbox.capture(write);
    return { status: "pending", memory };
  }

  /**
   * Capture is project-scoped because the policy and the default fact scope
   * both belong to the project that ran the agent. It is the hook Step 49's
   * `memory_write` connector will call; keeping it HTTP-first means the Desk,
   * CLI and any future harness all cross the same approval boundary.
   */
  app.post("/projects/:id/commons/captures", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    const body = objectBody(request.body);
    if (body === null) {
      return reply.code(400).send({ error: "Body must be a JSON object." });
    }
    const title = body["title"];
    const text = body["body"];
    const station = body["station"];
    const run = body["run"];
    if (typeof title !== "string" || title.trim() === "") {
      return reply.code(400).send({ error: "`title` is required." });
    }
    if (typeof text !== "string") {
      return reply.code(400).send({ error: "`body` is required." });
    }
    if (typeof station !== "string" || station.trim() === "") {
      return reply.code(400).send({ error: "`station` is required." });
    }
    if (typeof run !== "string" || run.trim() === "") {
      return reply.code(400).send({ error: "`run` is required." });
    }
    if (body["tags"] !== undefined && !stringArray(body["tags"])) {
      return reply.code(400).send({ error: "`tags` must be strings." });
    }
    try {
      const captured = (await captureMemory({
        title,
        body: text,
        tags: stringArray(body["tags"]) ? body["tags"] : [],
        project: runtime.project.id,
        station,
        run,
      })) as { status: "approved" | "pending" };
      return reply
        .code(captured.status === "approved" ? 201 : 202)
        .send(captured);
    } catch (error) {
      if (error instanceof MemoryCaptureError) {
        return reply.code(error.status).send({ error: error.message });
      }
      throw error;
    }
  });

  // ── Stations, per project ────────────────────────────────────────────────

  app.get("/projects/:id/stations", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    return describeStations(
      runtime.config(),
      prober,
      harnessRoles,
      harnessConfinement,
      knownHarnesses,
    );
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
      const stations = await describeStations(
        reloaded,
        prober,
        harnessRoles,
        harnessConfinement,
        knownHarnesses,
      );
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

  /**
   * The ledger — **per project**, which is the mirror image of `/usage` being
   * global and worth one line because they sit next to each other.
   *
   * A plan window belongs to a vendor: the same five-hour cap whichever
   * repository you are in. *Spend* belongs to the work that caused it, and the
   * run store is already per project. Answering this globally would mean
   * telling somebody what they spent this week without being able to say on
   * what, which is the number nobody needs.
   */
  app.get("/projects/:id/ledger", async (request, reply) => {
    const runtime = await runtimeFor(request, reply);
    if (!runtime) return reply;
    const query = request.query as Record<string, unknown>;
    // No `limit`: a ledger over the most recent N runs is a ledger that
    // quietly disagrees with itself as the window slides. The date range is
    // the honest way to ask for less, and Step 52's SQLite store is the
    // honest way to make asking for all of it cheap.
    return buildLedger(await runtime.store.list(), {
      ...(typeof query["since"] === "string" && { since: query["since"] }),
      ...(typeof query["until"] === "string" && { until: query["until"] }),
    });
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

    // **The pre-run check.** The README's complaint is that no vendor tells
    // you where you stand until you hit the wall, "usually eleven minutes into
    // something that mattered" — so a run that cannot finish is refused here,
    // at second zero, rather than dying halfway with a partial diff.
    //
    // Scoped to the harnesses this run will actually use. A run that only
    // touches `claude-code` must not be refused because a Codex Station
    // elsewhere in the config is capped; it would never have reached it.
    //
    // Only a *measured* window can refuse anything. `not-blocked`, `unknown`
    // and `unmetered` all start the run, because refusing on one of those
    // would be inventing a measurement — the same failure the strip avoids,
    // aimed at the operator's ability to work instead of at their bill.
    // **Routed first, then checked.** These two steps were built one after the
    // other and they disagree if run in the other order: a Station whose plan
    // is capped is exactly the Station `when_capped` exists to route around,
    // so checking the cuesheet as *written* would refuse every run that the
    // fallback was configured to rescue. The question this check asks is "can
    // this run finish as it will actually execute", which means resolving the
    // substitutions before counting anybody's cap.
    //
    // The executor resolves them again at run time rather than trusting this.
    // Not redundancy: a cuesheet can take twenty minutes, and a cap reached
    // during it should route the step that has not started yet.
    const windows = (await usage.get()).harnesses;
    const capped = cappedHarnesses(windows, loaded.config.limits);
    const routing = routeStations(loaded, stationIds, capped, harnessRoles);
    const check = checkLimits({
      limits: loaded.config.limits,
      usage: windows,
      harnesses: routing.harnesses,
    });
    if (check.decision === "block") {
      return reply.code(409).send({
        error: check.findings[0]?.reason ?? "A usage cap blocks this run.",
        // The windows, not just a sentence: the Desk has to be able to say
        // *which* vendor stopped it and how long until it resets.
        limits: check.findings,
        // And why the fallback did not rescue it. A refusal that says "you are
        // capped" while `when_capped` is configured and did nothing is a
        // refusal somebody spends an afternoon on.
        ...(routing.refusals.length > 0 && { routing: routing.refusals }),
      });
    }

    const run = await runtime.queue.enqueue({
      prompt,
      workspace,
      ...(cuesheet !== undefined && { cuesheetId: cuesheet }),
      stationIds,
    });
    // A warned run still starts. The threshold is a heads-up, not a gate —
    // `block_at` is the gate — so the findings ride along on the acceptance
    // rather than turning into a second request the client has to make.
    return reply.code(202).send({
      runId: run.id,
      ...(check.findings.length > 0 && { limits: check.findings }),
    });
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

/**
 * The distinct harnesses a run will touch **after** `when_capped` routing.
 *
 * A Station naming a harness that is not configured is left in rather than
 * filtered out: the run will fail on it either way, and dropping it here would
 * mean a capped harness silently stopped counting toward the check.
 */
function routeStations(
  loaded: LoadedConfig,
  stationIds: string[],
  capped: readonly string[],
  rolesOf: HarnessRoles,
): { harnesses: string[]; refusals: string[] } {
  const harnesses = new Set<string>();
  const refusals: string[] = [];

  for (const id of stationIds) {
    const station = loaded.config.station.find(
      (candidate) => candidate.id === id,
    );
    // A Station naming a harness that is not configured is left in rather than
    // filtered out: the run will fail on it either way, and dropping it would
    // mean a capped harness silently stopped counting toward the check.
    if (!station) continue;
    const routed = chooseFallback({
      station,
      limits: loaded.config.limits,
      stations: loaded.config.station,
      capped,
      rolesOf,
    });
    if (routed.kind === "refused") refusals.push(routed.reason);
    // A *refused* fallback keeps the original harness, which is what makes the
    // run refusable: the router could not rescue it, so the cap still applies.
    harnesses.add(
      routed.kind === "substitute" ? routed.station.harness : station.harness,
    );
  }

  return { harnesses: [...harnesses], refusals };
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

class CommonsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommonsConflictError";
  }
}

class MemoryCaptureError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MemoryCaptureError";
  }
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function stringEdit(
  edits: Record<string, unknown>,
  key: string,
  fallback: string,
  nonempty = true,
): string {
  const value = edits[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || (nonempty && value.trim() === "")) {
    throw new CommonsInboxError(
      `\`${key}\` must be a${nonempty ? " non-empty" : ""} string.`,
    );
  }
  return value;
}

function stringArrayEdit(
  edits: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] {
  const value = edits[key];
  if (value === undefined) return fallback;
  if (!stringArray(value)) {
    throw new CommonsInboxError(`\`${key}\` must be strings.`);
  }
  return value;
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

/** Drop anything in a JSON array that is not a string, rather than rejecting. */
function onlyStrings(values: readonly unknown[]): string[] {
  return values.filter((value): value is string => typeof value === "string");
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
