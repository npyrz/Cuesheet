/**
 * Cost metering for one run.
 *
 * Deliberately dumb: it adds numbers up and it tells the Desk as it goes.
 * The interesting decision — what to do when a harness reports both a stream
 * of deltas *and* a final total, which is the normal case and which the two
 * can disagree about — is the queue's, in `reconcileCost`. Making that call
 * twice, in two places, is how the two copies drift.
 */
import type { Cost } from "@cuesheet/core";
import type { CostDelta, HarnessEvent, Meter } from "./types.js";

export interface MeterOptions {
  emit?: (event: HarnessEvent) => void;
}

export function createMeter(options: MeterOptions = {}): Meter {
  let tokensIn = 0;
  let tokensOut = 0;
  // `undefined` rather than `0`, and kept that way until a harness reports
  // one: absent means "this runtime does not break input down", which is a
  // different claim from "none of it was cached". `codex` reports a read and
  // no write; a local model reports neither.
  let cacheRead: number | undefined;
  let cacheWrite: number | undefined;
  let usd: number | undefined;

  return {
    record(delta: CostDelta) {
      const inDelta = delta.tokensIn ?? 0;
      const outDelta = delta.tokensOut ?? 0;
      tokensIn += inDelta;
      tokensOut += outDelta;
      if (delta.cacheRead !== undefined)
        cacheRead = (cacheRead ?? 0) + delta.cacheRead;
      if (delta.cacheWrite !== undefined)
        cacheWrite = (cacheWrite ?? 0) + delta.cacheWrite;
      if (delta.usd !== undefined) usd = (usd ?? 0) + delta.usd;

      // A zero-token settlement that only carries a price is still worth
      // emitting; a wholly empty delta is not, and would be noise on the wire.
      if (inDelta === 0 && outDelta === 0 && delta.usd === undefined) return;

      options.emit?.({
        t: "cost",
        tokensIn: inDelta,
        tokensOut: outDelta,
        ...(delta.usd !== undefined && { usd: delta.usd }),
      });
    },

    total(): Cost {
      // `exactOptionalPropertyTypes`: absent means the harness could not price
      // it, which is not the same claim as "it cost nothing".
      return {
        tokensIn,
        tokensOut,
        ...(cacheRead !== undefined && { cacheRead }),
        ...(cacheWrite !== undefined && { cacheWrite }),
        ...(usd !== undefined && { usd }),
      };
    },
  };
}
