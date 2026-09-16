/**
 * The real runtime: the daemon wired to the harnesses that ship with it.
 *
 * `startDaemon` defaults to a no-op executor and an "everything is
 * uninstalled" prober, which is what keeps its tests fast, offline, and free.
 * That is the right default for a *library*, and the wrong one for the app —
 * so the two embedders that want real behaviour (`main.ts` here, and Step 21's
 * Electron main process) both spread this instead of assembling it twice and
 * drifting apart.
 */
import {
  defaultHarnessRegistry,
  type HarnessRegistry,
} from "@cuesheet/harness";
import { createHarnessExecutor } from "./harness-executor.js";
import type { ExecutorFactoryDeps } from "./server.js";
import type { RunExecutor } from "./executor.js";
import type { HarnessProber, HarnessRoles } from "./stations.js";
import type { UsageSource } from "./usage.js";

export interface HarnessRuntimeOptions {
  /** Defaults to the built-ins. Pass your own to add a third-party harness. */
  registry?: HarnessRegistry;
}

export interface HarnessRuntime {
  registry: HarnessRegistry;
  executorFactory: (deps: ExecutorFactoryDeps) => RunExecutor;
  prober: HarnessProber;
  harnessRoles: HarnessRoles;
  usageSources: () => readonly UsageSource[];
}

/**
 * ```ts
 * const handle = await startDaemon({ logger: true, ...harnessRuntime() });
 * ```
 *
 * `registry.probe` satisfies `HarnessProber` as-is: it takes a `HarnessId` and
 * resolves to a `HarnessProbe`, never throwing. That is not a coincidence —
 * `stations.ts` defined the prober as a bare function precisely so the daemon
 * would never need to know what a registry is.
 */
export function harnessRuntime(
  options: HarnessRuntimeOptions = {},
): HarnessRuntime {
  const registry = options.registry ?? defaultHarnessRegistry();
  return {
    registry,
    executorFactory: ({ config, env }) =>
      createHarnessExecutor({ registry, config, env }),
    prober: (harness) => registry.probe(harness),
    // `undefined` for a harness nobody registered, which is the answer that
    // warns about nothing — and the one `ollama` gets, since
    // `BUILTIN_HARNESS_IDS` lists it for probe ordering but no build ships it.
    harnessRoles: (harness) => registry.get(harness)?.roles,
    // Every registered harness, read at call time rather than captured, so a
    // registry that gains one later is picked up without a restart. A `Harness`
    // satisfies `UsageSource` structurally — the cache deliberately asks for
    // less than the interface offers.
    usageSources: () => registry.list(),
  };
}
