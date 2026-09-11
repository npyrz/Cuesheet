/**
 * The harness registry.
 *
 * Small on purpose. Its whole job is to be the one place that maps a
 * `harness = "claude-code"` string in someone's TOML onto a module, so that
 * adding the fourth harness is a one-line registration rather than a search
 * through the daemon for `if (harness === ...)`.
 */
import type { HarnessId, HarnessProbe } from "@cuesheet/core";
import type { Harness } from "./types.js";

export interface HarnessRegistry {
  register(harness: Harness): void;
  get(id: HarnessId): Harness | undefined;
  /** Every registered harness, in registration order. */
  list(): Harness[];
  ids(): HarnessId[];
  /** Probe one harness. Never throws — a broken probe is a failed probe. */
  probe(id: HarnessId): Promise<HarnessProbe>;
  probeAll(): Promise<HarnessProbe[]>;
}

export function createHarnessRegistry(
  harnesses: readonly Harness[] = [],
): HarnessRegistry {
  const byId = new Map<HarnessId, Harness>();
  for (const harness of harnesses) byId.set(harness.id, harness);

  /**
   * A probe shells out to somebody else's binary, and the failure modes are
   * "not installed", "hangs", and "throws" — none of which should be able to
   * take down `GET /stations`. So every outcome becomes a `HarnessProbe` with
   * an `error`, and the id is stamped from the entry we looked up rather than
   * trusted from the answer.
   */
  async function probe(id: HarnessId): Promise<HarnessProbe> {
    const harness = byId.get(id);
    if (!harness) {
      return {
        harness: id,
        installed: false,
        authed: false,
        error: `No harness named "${id}" is registered.`,
      };
    }
    try {
      const result = await harness.probe();
      return { ...result, harness: id };
    } catch (error) {
      return {
        harness: id,
        installed: false,
        authed: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    register(harness) {
      byId.set(harness.id, harness);
    },

    get(id) {
      return byId.get(id);
    },

    list() {
      return [...byId.values()];
    },

    ids() {
      return [...byId.keys()];
    },

    probe,

    async probeAll() {
      return Promise.all([...byId.keys()].map(probe));
    },
  };
}
