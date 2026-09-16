/**
 * The pre-run check — "can this run finish?", decided before it starts.
 *
 * The README's framing is the specification: every vendor meters differently
 * and none of them tell you where you stand until you hit the wall, *"usually
 * eleven minutes into something that mattered."* This file is what turns that
 * into a refusal at second zero instead.
 *
 * Pure, and in `core` rather than in the daemon, for the same reason
 * `gate.ts` is: it is a policy decision over data, and a policy that can only
 * be exercised by standing up an HTTP server is a policy nobody tests
 * exhaustively.
 *
 * ## What it can and cannot know, stated plainly
 *
 * **Only a `measured` window can block a run.** That is not a limitation of
 * this file — it is the whole reason `UsageWindow` is a union. A
 * `not-blocked` window means the vendor has not cut you off *yet* and says
 * nothing about how close you are; `unknown` means nobody said; `unmetered`
 * means there is no cap to hit. Refusing a run on any of those three would be
 * inventing a measurement, which is the failure this phase exists to avoid,
 * pointed at the operator's ability to work rather than at their bill.
 *
 * The consequence is worth knowing before reading the tests: today the only
 * shipped path to a `measured` window is `claude-code` reporting
 * `isUsingOverage: true`. A plan that is not in overage, a Codex that reports
 * nothing, and a local model all produce runs that start.
 */
import type { Limits } from "./config.js";
import type { HarnessUsage, UsageWindow, Vendor } from "./types.js";

export type LimitDecision = "go" | "warn" | "block";

/** One window that had something to say about a run. */
export interface LimitFinding {
  vendor: Vendor;
  window: string;
  /** The fraction that triggered this. Only a measurement can. */
  used: number;
  reason: string;
}

export interface LimitCheck {
  decision: LimitDecision;
  /** Every window at or past `warn_at`, worst first. Empty when `go`. */
  findings: LimitFinding[];
}

export interface LimitCheckInput {
  limits: Limits;
  /** Usage for every harness, as `GET /usage` serves it. */
  usage: readonly HarnessUsage[];
  /**
   * Which harnesses this run will actually use.
   *
   * Absent means "all of them", which is the right answer for a strip and the
   * wrong one for a pre-run check: a run that only touches `claude-code` must
   * not be refused because a Codex Station elsewhere in the config is capped.
   */
  harnesses?: readonly string[];
}

/**
 * Decide whether a run may start.
 *
 * Worst window wins. A run blocked by one vendor is blocked however healthy
 * the others are — the cuesheet is sequential, so a step that cannot run stops
 * the run whether it is the first or the last.
 */
export function checkLimits(input: LimitCheckInput): LimitCheck {
  const { limits } = input;
  const relevant =
    input.harnesses === undefined
      ? input.usage
      : input.usage.filter((entry) => input.harnesses?.includes(entry.harness));

  const findings: LimitFinding[] = [];
  let decision: LimitDecision = "go";

  for (const entry of relevant) {
    for (const window of entry.windows) {
      const used = measuredFraction(window);
      if (used === null) continue;

      if (used >= limits.block_at) {
        decision = "block";
        findings.push({
          vendor: entry.vendor,
          window: window.window,
          used,
          reason:
            `${entry.vendor}'s ${window.window} window is at ` +
            `${percent(used)} of its cap, and block_at is ` +
            `${percent(limits.block_at)}. This run would not finish.`,
        });
      } else if (used >= limits.warn_at) {
        if (decision === "go") decision = "warn";
        findings.push({
          vendor: entry.vendor,
          window: window.window,
          used,
          reason:
            `${entry.vendor}'s ${window.window} window is at ` +
            `${percent(used)} of its cap.`,
        });
      }
    }
  }

  // Worst first, so a client that renders only the top line renders the one
  // that actually stopped the run.
  findings.sort((a, b) => b.used - a.used);
  return { decision, findings };
}

/**
 * The fraction a window measured, or `null` when it measured nothing.
 *
 * The single place the union's guarantee is cashed in: three of the four
 * variants have no `used` field, so there is nothing here to fall back to and
 * no `?? 0` to write by accident.
 */
export function measuredFraction(window: UsageWindow): number | null {
  return window.state === "measured" ? window.used : null;
}

/** `71%`. Rounded for prose; never used to make the decision itself. */
export function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}
