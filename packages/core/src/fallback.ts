/**
 * `when_capped` — routing around a Station that cannot run.
 *
 * Pure, so the rules below can be hammered without a daemon. They matter more
 * than the mechanism: **a substitution silently changes who did the work**, and
 * the two things Cuesheet enforces structurally are both stated in terms of who
 * did it.
 *
 * ## The two refusals, and why each is not a preference
 *
 * 1. **A Station may only stand in for one holding the same role.** Step 36
 *    made "a worker in a reviewer seat" a warning the daemon prints, on the
 *    README's argument that a small local model reviewing a frontier model's
 *    diff approves nearly everything. A router that performs that swap at
 *    runtime would be doing silently, and unprompted, exactly what the config
 *    linter exists to warn a human about.
 *
 * 2. **The substitute's harness must actually declare the role.** Same reason,
 *    one level down: `ollama` ships `roles: ["worker"]`, so a config naming it
 *    as a reviewer's fallback is a config error, not an instruction.
 *
 * ## What is deliberately *not* checked here
 *
 * A Gate's `distinct_vendors`. It needs no check, and the reason is worth
 * knowing before somebody adds one: `evaluateGate` counts vendors over
 * `participants`, which the executor builds from the harness that *actually
 * ran*. Swap a second-vendor reviewer for a same-vendor one and the gate sees
 * one vendor and holds the run — honestly, with its own message, without this
 * file needing to predict it. Adding a pre-emptive check here would duplicate
 * that logic in a second place and the two would drift.
 */
import type { Limits, Station } from "./config.js";
import type { HarnessId, Role } from "./types.js";

export interface FallbackInput {
  /** The Station the cuesheet asked for. */
  station: Station;
  limits: Limits;
  /** Every configured Station, by id. */
  stations: readonly Station[];
  /** Harness ids whose plan is at or past `block_at`. */
  capped: readonly HarnessId[];
  /** What a harness can play, or `undefined` when nobody knows. */
  rolesOf: (harness: HarnessId) => readonly Role[] | undefined;
}

export type FallbackDecision =
  /** Run the Station as written. */
  | { kind: "proceed" }
  /** Run `station` instead, standing in for the original. */
  | { kind: "substitute"; station: Station; reason: string }
  /** A fallback was configured and refused. The run proceeds and will fail. */
  | { kind: "refused"; reason: string };

export function chooseFallback(input: FallbackInput): FallbackDecision {
  const { station, limits, capped, stations, rolesOf } = input;

  if (!capped.includes(station.harness)) return { kind: "proceed" };

  const fallbackId = limits.when_capped[station.id];
  if (fallbackId === undefined) {
    return {
      kind: "refused",
      reason:
        `Station "${station.id}" is capped and has no \`when_capped\` ` +
        `fallback configured.`,
    };
  }

  const fallback = stations.find((candidate) => candidate.id === fallbackId);
  if (!fallback) {
    return {
      kind: "refused",
      reason:
        `\`when_capped\` routes "${station.id}" to "${fallbackId}", which is ` +
        `not a configured Station.`,
    };
  }

  if (fallback.role !== station.role) {
    return {
      kind: "refused",
      reason:
        `"${fallbackId}" is a ${fallback.role} and cannot stand in for the ` +
        `${station.role} "${station.id}". A seat is not a preference — swapping ` +
        `roles here would do silently what the config linter warns about.`,
    };
  }

  const roles = rolesOf(fallback.harness);
  if (roles !== undefined && !roles.includes(station.role)) {
    return {
      kind: "refused",
      reason:
        `"${fallbackId}" runs on \`${fallback.harness}\`, which cannot play the ` +
        `${station.role} seat.`,
    };
  }

  if (capped.includes(fallback.harness)) {
    return {
      kind: "refused",
      reason: `"${fallbackId}" is capped too; there is nowhere to route.`,
    };
  }

  return {
    kind: "substitute",
    station: fallback,
    reason: `"${station.id}" is at its cap, so "${fallbackId}" is taking this step.`,
  };
}
