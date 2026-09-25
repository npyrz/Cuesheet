/**
 * One daemon, many projects.
 *
 * Phase 8 committed to this shape at the top rather than leaving it to the
 * work: **one daemon serving many projects, not one daemon per project.** The
 * port is fixed by design — `findRunningDaemon` and the lockfile exist so every
 * client, including a second window and later the phone, finds *the* daemon —
 * so a daemon per project would multiply ports, lockfiles and trays and break
 * the one contract the architecture is arranged around. Project scope therefore
 * lives on the routes and in here, never in the process.
 *
 * A {@link ProjectRuntime} is everything that used to be a single value in
 * `startDaemon`: the config, the reload closure, the run store, the queue, and
 * the executor built from that config. Three of those were the places the plan
 * named as baking in single-project scope, and they are all here now.
 *
 * Four properties this file exists to hold:
 *
 * - **Runtimes are memoized by promise, not by result.** A check-then-create
 *   would let two concurrent requests for a cold project both reconcile its
 *   store and both build a queue — two queues over one root, which is the same
 *   lost-update shape `projects.json` is serialized against. Storing the
 *   in-flight promise makes the second caller await the first.
 * - **Reconciliation happens when a project is first touched, not at boot.**
 *   See {@link ProjectRuntimes.get}.
 * - **Every project gets its own bus, mirrored into a daemon-wide one.** The
 *   Desk subscribes per project and cannot see another's events; the desktop
 *   shell keeps one subscription for notifications.
 * - **The standby registry is shared, deliberately.** Standby ids are unique
 *   across the daemon and `POST /standbys/:id` stays a global route. One
 *   registry per runtime would break that route for every project but the
 *   first, silently.
 */
import {
  hostEnv,
  loadConfigFrom,
  pathFor,
  projectConfigFile,
  projectConfigSearchPaths,
  projectRunsDir,
  type HostEnv,
  type LoadedConfig,
  type MigrationLog,
  type Project,
  type ProjectRegistry,
} from "@cuesheet/core";
import { createEventBus, DEFAULT_REPLAY_LIMIT, type EventBus } from "./bus.js";
import type { RunStore } from "./store.js";
import { openRunStore, type RunStoreBackend } from "./store-backend.js";
import { RUNS_DB_FILENAME, type RunsMigration } from "./store-sqlite.js";
import { createRunQueue, type RunQueue } from "./queue.js";
import { reconcileInterruptedRuns } from "./reconcile.js";
import type { RunExecutor } from "./executor.js";
import type { StandbyRegistry } from "./standby.js";
import type { ExecutorFactoryDeps } from "./server.js";

export interface ProjectRuntime {
  readonly project: Project;
  readonly store: RunStore;
  readonly queue: RunQueue;
  /** This project's events only. `GET /projects/:id/ws` serves this. */
  readonly bus: EventBus;
  /** Reads the currently loaded config. Call per request, never cache it. */
  config(): LoadedConfig;
  reload(): Promise<LoadedConfig>;
  /** Where `POST /stations` creates a config when this project has none. */
  readonly configFallbackPath: string;
  close(): Promise<void>;
}

export interface ProjectRuntimesOptions {
  registry: ProjectRegistry;
  env?: HostEnv;
  /** Every project's events are mirrored here, for the tray and for tests. */
  globalBus: EventBus;
  /** Shared across projects, because standby ids are daemon-wide. */
  standbys: StandbyRegistry;
  executor?: RunExecutor;
  executorFactory?: (deps: ExecutorFactoryDeps) => RunExecutor;
  /**
   * Build a project's run store. Defaults to `~/.cuesheet/projects/<id>/runs`
   * — a `runs.db` there since Step 52, run directories beside it before that
   * and still, since the SQLite store imports them and leaves them alone.
   *
   * A root per project rather than one root keyed by project, which the plan
   * left to the work. The deciding property is `store.list(limit)`: run ids are
   * timestamp-prefixed so a lexical sort of directory names *is* a
   * chronological sort, which lets `list()` answer off `readdir` alone without
   * opening a single `run.json`. A shared root would mean filtering every run
   * ever — the O(all runs) shape `reconcile.ts` already flags as where the file
   * store's scaling shows through — or maintaining an index. Per-project keeps
   * the cheap property and makes Step 33's migration a directory move, and it
   * survived the move to SQLite unchanged: one database per project rather
   * than one keyed by it, for the same isolation reason.
   */
  storeFactory?: (project: Project) => RunStore | Promise<RunStore>;
  /**
   * Which backend the default factory opens. Defaults to SQLite, falling back
   * to files on a runtime without `node:sqlite`. See `store-backend.ts`.
   */
  storeBackend?: RunStoreBackend;
  /** Off only for tests that want to assert on an unreconciled store. */
  reconcile?: boolean;
  /** Where a store that migrated on open says so. Absent means unrecorded. */
  migrationLog?: MigrationLog;
  replayLimit?: number;
}

export interface ProjectRuntimes {
  /** `null` for a project id the registry does not know. */
  get(id: string): Promise<ProjectRuntime | null>;
  /** Ids with a live runtime — not every registered project. */
  live(): string[];
  closeAll(): Promise<void>;
}

export function createProjectRuntimes(
  options: ProjectRuntimesOptions,
): ProjectRuntimes {
  const env = options.env ?? hostEnv();
  const reconcile = options.reconcile ?? true;
  const { registry, globalBus, standbys } = options;
  const runtimes = new Map<string, Promise<ProjectRuntime | null>>();

  /**
   * Log what opening a store changed. Two things count, and creating a new
   * database for a new project is neither: a store that imported history, and
   * a store that already had a schema and was moved to the next one.
   *
   * Logged after the fact and never read back, so a failure to write the line
   * is not a reason to refuse the project — the migration itself committed.
   */
  async function recordStoreMigration(
    project: Project,
    store: RunStore,
  ): Promise<void> {
    const log = options.migrationLog;
    const migration = storeMigration(store);
    if (!log || !migration) return;
    const root = projectRunsDir(project.id, env);
    try {
      if (migration.imported > 0 || migration.unreadable > 0) {
        await log.record({
          kind: "runs-import",
          project: project.id,
          from: root,
          to: pathFor(env).join(root, RUNS_DB_FILENAME),
          detail:
            `Copied ${String(migration.imported)} run(s) from the file store into SQLite; ` +
            `the directories were left in place.` +
            (migration.unreadable > 0
              ? ` ${String(migration.unreadable)} unreadable run director${migration.unreadable === 1 ? "y was" : "ies were"} skipped and left on disk.`
              : ""),
        });
      }
      if (migration.from > 0) {
        await log.record({
          kind: "runs-schema",
          project: project.id,
          from: String(migration.from),
          to: String(migration.to),
        });
      }
    } catch {
      // See above: the record is for people, and the migration is already done.
    }
  }

  async function build(project: Project): Promise<ProjectRuntime> {
    // First, before anything is opened or attached. A config this build
    // refuses — broken, or written by a newer build — throws here, and a
    // build that failed *after* opening the store would leave a database
    // handle open on every retry, which on Windows also pins the directory.
    let loaded = await loadConfigFrom(
      projectConfigSearchPaths(project.root, project.id, env),
    );

    const bus = createEventBus({
      replayLimit: options.replayLimit ?? DEFAULT_REPLAY_LIMIT,
    });
    // Mirrored, not shared. A client attaches to this project's bus and gets
    // this project's backlog; the daemon-wide bus still sees everything so the
    // tray can notify on a standby whatever project raised it.
    const mirror = bus.attach((event) => globalBus.emit(event));

    const store =
      (await options.storeFactory?.(project)) ??
      (await openRunStore({
        env,
        root: projectRunsDir(project.id, env),
        ...(options.storeBackend !== undefined && {
          backend: options.storeBackend,
        }),
      }));
    await recordStoreMigration(project, store);

    const config = (): LoadedConfig => loaded;
    const reload = async (): Promise<LoadedConfig> => {
      loaded = await loadConfigFrom(
        projectConfigSearchPaths(project.root, project.id, env),
      );
      return loaded;
    };

    // Before the queue can serve anything. `startDaemon` used to do this once
    // at boot, on the argument that a run still marked `running` on disk
    // belongs to a process that is gone — which is still true, but is now true
    // per project at the moment that project is first touched. Nobody can
    // observe an unreconciled run before its runtime exists, and this is
    // O(projects actually opened) rather than O(every project ever
    // registered), on every boot, forever.
    if (reconcile) await reconcileInterruptedRuns({ store });

    const queue = createRunQueue({
      store,
      bus,
      standbys,
      executor:
        options.executor ??
        options.executorFactory?.({
          config,
          env,
          projectId: project.id,
          // `startDaemon` replaces this with the real scoped Commons reader.
          // Keeping a harmless default here preserves this module's boundary:
          // project lifetimes do not own the global Commons store.
          memoryFacts: async () => [],
        }) ??
        noopExecutor,
    });

    return {
      project,
      store,
      queue,
      bus,
      config,
      reload,
      configFallbackPath: projectConfigFile(project.id, env),
      async close() {
        mirror.unsubscribe();
        await queue.shutdown();
        // After the queue, never before: a store closed under a running run
        // turns its final `finish` into a write to a closed database. The
        // file store has nothing to close and says so by omitting the method.
        await store.close?.();
      },
    };
  }

  return {
    get(id) {
      const existing = runtimes.get(id);
      if (existing) return existing;

      // Memoize the *promise*, and — the part that is easy to get wrong and
      // was — insert it into the map **synchronously**, before the first
      // `await`. An earlier version resolved the project from the registry
      // first; every concurrent caller then got past the check above while
      // that lookup was in flight, and each built its own queue over one store
      // root. That is the lost-update shape `projects.json` is serialized
      // against, arriving by a different door. A test asserts identity across
      // three concurrent cold `get`s precisely because nothing else would have
      // noticed.
      const pending = (async (): Promise<ProjectRuntime | null> => {
        // `registry.get` rather than trusting the caller: an id that is not in
        // the registry has no root, and `projectDir` would refuse it anyway.
        const project = await registry.get(id);
        if (!project) return null;
        return build(project);
      })();
      runtimes.set(id, pending);
      // Neither an unknown project nor a failed build may stay cached: the
      // first would outlive someone opening that folder a second later, and
      // the second would make one transient error permanent for the life of
      // the daemon.
      void pending
        .then((runtime) => {
          if (runtime === null) runtimes.delete(id);
        })
        .catch(() => runtimes.delete(id));
      return pending;
    },

    live() {
      return [...runtimes.keys()];
    },

    async closeAll() {
      const pending = [...runtimes.values()];
      runtimes.clear();
      await Promise.all(
        pending.map(async (runtime) => {
          try {
            await (await runtime)?.close();
          } catch {
            // A runtime that failed to build has nothing to close, and one
            // that throws on shutdown must not strand the others.
          }
        }),
      );
    },
  };
}

const noopExecutor: RunExecutor = () =>
  Promise.resolve({
    status: "done" as const,
    cost: { tokensIn: 0, tokensOut: 0 },
    durationMs: 0,
  });

/** The migration a store performed on open, when it is a store that can. */
function storeMigration(store: RunStore): RunsMigration | null {
  const migration = (store as { migration?: RunsMigration | null }).migration;
  return migration ?? null;
}
