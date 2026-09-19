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
  type ContextFile,
  type HarnessRegistry,
} from "@cuesheet/harness";
import { createHarnessExecutor } from "./harness-executor.js";
import type { ExecutorFactoryDeps } from "./server.js";
import type { RunExecutor } from "./executor.js";
import type {
  HarnessConfinement,
  HarnessProber,
  HarnessRoles,
  KnownHarnesses,
} from "./stations.js";
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
  harnessConfinement: HarnessConfinement;
  knownHarnesses: KnownHarnesses;
  usageSources: () => readonly UsageSource[];
  contextFiles: () => readonly ContextFile[];
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
    executorFactory: ({ config, env, capped }) =>
      createHarnessExecutor({
        registry,
        config,
        env,
        ...(capped !== undefined && { capped }),
      }),
    prober: (harness) => registry.probe(harness),
    // `undefined` for a harness nobody registered, which is the answer that
    // warns about nothing — and the one `ollama` gets, since
    // `BUILTIN_HARNESS_IDS` lists it for probe ordering but no build ships it.
    harnessRoles: (harness) => registry.get(harness)?.roles,
    // Optional on the interface, so this is two `undefined`s that mean
    // different things and both come out the same way: no such harness, and a
    // harness that declines to say. Neither is "nothing confines it" — the
    // Desk prints those two as "unknown" and only a declared "none" as the
    // claim that the leash is the whole boundary.
    harnessConfinement: (harness, role) =>
      registry.get(harness)?.confinement?.(role),
    // What this build actually registered — `mock` included, which is the
    // whole of Step 45's finding: the demo harness has shipped since Phase 3
    // and `GET /stations` had no way to mention it, so no UI could offer it.
    knownHarnesses: () => registry.ids(),
    // Every registered harness, read at call time rather than captured, so a
    // registry that gains one later is picked up without a restart. A `Harness`
    // satisfies `UsageSource` structurally — the cache deliberately asks for
    // less than the interface offers.
    usageSources: () => registry.list(),
    // The projector consumes the interface rather than knowing that Claude
    // reads CLAUDE.md and Codex reads AGENTS.md. A third-party harness gets the
    // same projection simply by declaring another target.
    contextFiles: () =>
      registry.list().flatMap((harness) => harness.contextFiles),
  };
}
