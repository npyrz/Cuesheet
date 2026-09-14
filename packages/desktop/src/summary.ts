/**
 * What a finished run says in a notification.
 *
 * Pure, and in its own file, because the alternative is arithmetic that only
 * runs when a notification fires — inside a bus listener, where
 * `createEventBus` catches a throw and logs it. A mistake here would look
 * exactly like a notification that never arrived, on a path nobody watches.
 */
import type { RunResultSummary } from "@cuesheet/core/types";

export function summarise(result: RunResultSummary | undefined): string {
  if (result === undefined) return "The run is finished.";

  // Rounded up rather than down: a run that took 400ms reads "1s", not "0s".
  const seconds = Math.max(1, Math.round(result.durationMs / 1000));
  const parts = [`${result.status} in ${seconds}s`];

  if (result.diff !== undefined) {
    const files = result.diff.filesChanged;
    parts.push(`${files} file${files === 1 ? "" : "s"} changed`);
  }

  // The price is the *run's*, and here it is actually known — unlike on a
  // tile, where a Station's share of a multi-Station run would be invented.
  // A local model has tokens and no price, and says nothing rather than "$0".
  if (result.cost.usd !== undefined) {
    parts.push(`$${result.cost.usd.toFixed(2)}`);
  }

  return parts.join(" · ");
}
