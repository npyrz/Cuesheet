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
  projectConfigFile,
  projectConfigSearchPaths,
  projectRunsDir,
  type HostEnv,
  type LoadedConfig,
  type Project,
  type ProjectRegistry,
} from "@cuesheet/core";
import { createEventBus, DEFAULT_REPLAY_LIMIT, type EventBus } from "./bus.js";
import { createFileRunStore, type RunStore } from "./store.js";
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
   * Build a project's run store. Defaults to files under
   * `~/.cuesheet/projects/<id>/runs`.
   *
   * A root per project rather than one root keyed by project, which the plan
   * left to the work. The deciding property is `store.list(limit)`: run ids are
   * timestamp-prefixed so a lexical sort of directory names *is* a
   * chronological sort, which lets `list()` answer off `readdir` alone without
   * opening a single `run.json`. A shared root would mean filtering every run
   * ever — the O(all runs) shape `reconcile.ts` already flags as where the file
   * store's scaling shows through — or maintaining an index. Per-project keeps
   * the cheap property and makes Step 33's migration a directory move.
   */
  storeFactory?: (project: Project) => RunStore;
  /** Off only for tests that want to assert on an unreconciled store. */
  reconcile?: boolean;
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

  async function build(project: Project): Promise<ProjectRuntime> {
    const bus = createEventBus({
      replayLimit: options.replayLimit ?? DEFAULT_REPLAY_LIMIT,
    });
    // Mirrored, not shared. A client attaches to this project's bus and gets
    // this project's backlog; the daemon-wide bus still sees everything so the
    // tray can notify on a standby whatever project raised it.
    const mirror = bus.attach((event) => globalBus.emit(event));

    const store =
      options.storeFactory?.(project) ??
      createFileRunStore({ root: projectRunsDir(project.id, env) });

    let loaded = await loadConfigFrom(
      projectConfigSearchPaths(project.root, project.id, env),
    );
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
