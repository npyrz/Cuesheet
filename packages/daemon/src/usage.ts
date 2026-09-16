/**
 * Plan usage, cached — what `GET /usage` serves.
 *
 * The limits strip's job is to stop someone being cut off eleven minutes into
 * something that mattered. That makes this file's failure mode specific and
 * worth stating before the code: **a strip that looks authoritative and is
 * wrong is worse than no strip.** So every path here ends in one of the four
 * answers `UsageWindow` can express, and none of them ends in a plausible
 * number nobody reported.
 *
 * Three properties, each of which is a decision:
 *
 * - **Never blocks.** `usage()` reaches a CLI on some harnesses, and a CLI can
 *   hang. A hung one must not take `GET /usage` with it, so the wait is
 *   bounded and the timeout is an *answer* — `unknown`, with the reason —
 *   rather than a dropped row. A harness missing from the response and a
 *   harness reporting "unknown" are the two answers that must not collapse.
 * - **Never throws.** Same reasoning as `registry.probe`: a broken harness is
 *   a failed reading, not a failed request.
 * - **Cached with a TTL.** The Desk polls, and `claude-code`'s answer changes
 *   only when a run overhears a new limit. Polling per request would spawn
 *   processes on a timer for data that did not move.
 */
import type {
  HarnessId,
  HarnessUsage,
  UsageWindow,
  Vendor,
} from "@cuesheet/core";

/**
 * What the cache needs from a harness, and nothing more.
 *
 * Structural rather than `Harness`, so `usage.ts` does not depend on
 * `@cuesheet/harness` to answer a question about numbers. `harnessRuntime()`
 * supplies the registry's entries, which satisfy this as they are.
 */
export interface UsageSource {
  id: HarnessId;
  vendor: Vendor;
  usage(): Promise<UsageWindow[]>;
}

export interface UsageCacheOptions {
  /** Read at call time, so a registry that gains a harness is picked up. */
  sources: () => readonly UsageSource[];
  /** How long a reading stays fresh. */
  ttlMs?: number;
  /** How long one harness gets to answer before it is recorded as unknown. */
  timeoutMs?: number;
  now?: () => number;
}

export interface UsageResponse {
  harnesses: HarnessUsage[];
}

export interface UsageCache {
  /** Never rejects. Refreshes what has gone stale and serves the rest. */
  get(): Promise<UsageResponse>;
  /**
   * Drop everything, so the next `get()` re-reads.
   *
   * Called when a run finishes — see `server.ts`, which attaches to the bus
   * for it. That is the one moment plan usage actually moves: `claude-code`
   * learns its limits only from inside a run, so serving a cached window from
   * before the run that consumed it is the stalest answer this cache can give.
   */
  clear(): void;
}

/** Long enough that the Desk polling does not spawn processes on a timer. */
export const DEFAULT_USAGE_TTL_MS = 30_000;

/**
 * Two seconds, matching the probe timeout in the harnesses.
 *
 * The number is a judgement rather than a measurement: a usage read that takes
 * longer than a couple of seconds has already failed at its job, because the
 * strip is something an operator glances at before starting work.
 */
export const DEFAULT_USAGE_TIMEOUT_MS = 2_000;

export function createUsageCache(options: UsageCacheOptions): UsageCache {
  const ttlMs = options.ttlMs ?? DEFAULT_USAGE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const cached = new Map<HarnessId, { at: number; windows: UsageWindow[] }>();
  // In-flight reads, keyed by harness, so two concurrent `GET /usage` calls on
  // a cold cache do not both spawn the same CLI. Same reasoning as the project
  // runtimes' memoize-the-promise rule, and the same bug if it is skipped.
  const inFlight = new Map<HarnessId, Promise<UsageWindow[]>>();

  async function read(source: UsageSource): Promise<UsageWindow[]> {
    const fresh = cached.get(source.id);
    if (fresh && now() - fresh.at < ttlMs) return fresh.windows;

    const existing = inFlight.get(source.id);
    if (existing) return existing;

    const pending = (async (): Promise<UsageWindow[]> => {
      const windows = await withTimeout(source, timeoutMs);
      cached.set(source.id, { at: now(), windows });
      return windows;
    })().finally(() => inFlight.delete(source.id));

    inFlight.set(source.id, pending);
    return pending;
  }

  return {
    async get(): Promise<UsageResponse> {
      const sources = options.sources();
      const harnesses = await Promise.all(
        sources.map(async (source) => ({
          harness: source.id,
          vendor: source.vendor,
          windows: await read(source),
        })),
      );
      return { harnesses };
    },

    clear() {
      cached.clear();
    },
  };
}

/**
 * One harness's reading, bounded, with every failure turned into an answer.
 *
 * The timer is cleared on the happy path. Leaving it would keep the process
 * alive for the length of the timeout after an otherwise finished request,
 * which is the kind of thing that turns a clean `daemon.close()` into a test
 * that hangs for two seconds and then passes.
 */
async function withTimeout(
  source: UsageSource,
  timeoutMs: number,
): Promise<UsageWindow[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<UsageWindow[]>((resolve) => {
    timer = setTimeout(
      () =>
        resolve([
          {
            window: "plan",
            state: "unknown",
            reason: `\`${source.id}\` did not report usage within ${String(timeoutMs)}ms.`,
          },
        ]),
      timeoutMs,
    );
  });

  try {
    const windows = await Promise.race([source.usage(), timeout]);
    return windows.length > 0 ? windows : [silent(source.id)];
  } catch (error) {
    return [
      {
        window: "plan",
        state: "unknown",
        reason: error instanceof Error ? error.message : String(error),
      },
    ];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * What an empty answer means, said out loud.
 *
 * `[]` from a harness is not "no limits" — `codex` returns it because its
 * stream carries token counts and no plan window at all, and a harness that
 * has simply never run returns it too. Both are "nobody said", and the strip
 * has to render that differently from `unmetered`, which is a positive claim
 * that no cap exists.
 */
function silent(id: HarnessId): UsageWindow {
  return {
    window: "plan",
    state: "unknown",
    reason: `\`${id}\` reports no plan windows.`,
  };
}
