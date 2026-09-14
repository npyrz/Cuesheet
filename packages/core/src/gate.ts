/**
 * Gate evaluation — the check no vendor will build for you.
 *
 * Pure, like `leash.ts`, and for the same reason: this is the function that
 * decides whether work is allowed through, so it has to be exhaustively
 * testable without a process, a model, or a network. Everything it needs is
 * an argument.
 *
 * The thesis, stated once so the rules below read as consequences of it: a
 * model reviewing its own work shares its own blind spots. A Gate is what
 * turns "get a second opinion from somewhere else" from a habit you have to
 * remember into a line of config.
 */
import type { DiffStat, Finding, HarnessId, Vendor, Verdict } from "./types.js";
// Type-only, so this module keeps `types.ts`'s property of importing nothing
// at runtime: `config.ts` reaches zod and smol-toml, and `verbatimModuleSyntax`
// erases an `import type` entirely.
import type { Gate } from "./config.js";

/** A Station that actually acted in the run — author or reviewer. */
export interface GateParticipant {
  stationId: string;
  harness: HarnessId;
  vendor: Vendor;
}

export interface GateInput {
  /** Every verdict recorded so far in this run, in order. */
  verdicts: readonly Verdict[];
  /**
   * The Stations that have acted. Author *and* reviewers — see
   * `distinct_vendors` below, where the difference is the whole point.
   */
  participants: readonly GateParticipant[];
  /** The run's diff at this cue, for `skip_if_diff_under`. */
  diff?: DiffStat | undefined;
}

export type GateOutcome = "pass" | "hold" | "skipped";

export interface GateResult {
  outcome: GateOutcome;
  /** Why, in the words the standby and the run record will use. */
  reasons: string[];
  /** The blocking findings, when the gate held because of them. */
  blocking: Finding[];
  /** `{ required, of, passed }` — the arithmetic behind a `require` failure. */
  tally: { required: number; of: number; passed: number };
  vendors: Vendor[];
}

/** `"2-of-3"` → `{ required: 2, of: 3 }`. */
export function parseRequire(require: string): {
  required: number;
  of: number;
} {
  const match = /^(\d+)-of-(\d+)$/.exec(require);
  if (!match) return { required: 1, of: 1 };
  return { required: Number(match[1]), of: Number(match[2]) };
}

/**
 * Does this run get through the gate?
 *
 * The order of the checks is deliberate. `skip_if_diff_under` comes first
 * because a gate that was never going to run should not report a vendor
 * failure for a two-line change. Everything after it is a reason to hold.
 */
export function evaluateGate(gate: Gate, input: GateInput): GateResult {
  const { required, of } = parseRequire(gate.require);
  const vendors = [...new Set(input.participants.map((p) => p.vendor))];
  const passed = input.verdicts.filter((v) => v.decision === "pass").length;
  const tally = { required, of, passed };

  // A typo is not worth a review. Counted in changed lines rather than files,
  // which is what the README's `skip_if_diff_under = 20` reads as.
  if (gate.skip_if_diff_under !== undefined && input.diff !== undefined) {
    const lines = input.diff.insertions + input.diff.deletions;
    if (lines < gate.skip_if_diff_under) {
      return {
        outcome: "skipped",
        reasons: [
          `Diff is ${lines} line${lines === 1 ? "" : "s"}, under the gate's threshold of ${gate.skip_if_diff_under}.`,
        ],
        blocking: [],
        tally,
        vendors,
      };
    }
  }

  const reasons: string[] = [];

  // Blocking findings hold the run whatever the arithmetic says. A reviewer
  // can report `pass` while still filing something in a blocking category —
  // "looks fine, but this leaks the key" — and the category wins.
  const blocking = input.verdicts
    .flatMap((verdict) => verdict.findings)
    .filter((finding) => gate.blocking.includes(finding.category));
  if (blocking.length > 0) {
    const categories = [...new Set(blocking.map((f) => f.category))];
    reasons.push(
      `${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"} (${categories.join(", ")}).`,
    );
  }

  // An abstention is not a pass. A reviewer whose output could not be read as
  // a verdict has not approved anything, and counting silence as approval is
  // the difference between a safety feature and a decoration.
  if (passed < required) {
    reasons.push(
      `${passed} of ${required} required approval${required === 1 ? "" : "s"} (${input.verdicts.length} review${input.verdicts.length === 1 ? "" : "s"} recorded).`,
    );
  }

  // The second opinion has to come from somewhere else. Counted over the
  // Stations that *acted*, not the verdict authors: with `require = "1-of-1"`
  // and `distinct_vendors = 2` there is only one reviewer, so the second
  // vendor can only be the engineer whose work is under review — which is the
  // README's own example, and the entire point of the feature.
  if (vendors.length < gate.distinct_vendors) {
    reasons.push(
      `Work and review came from ${vendors.length} vendor${vendors.length === 1 ? "" : "s"} (${vendors.join(", ") || "none"}); this gate requires ${gate.distinct_vendors}.`,
    );
  }

  return {
    outcome: reasons.length === 0 ? "pass" : "hold",
    reasons,
    blocking,
    tally,
    vendors,
  };
}

/** One line for a standby prompt or a run record. */
export function describeGate(name: string, result: GateResult): string {
  if (result.outcome === "pass") return `Gate "${name}" passed.`;
  if (result.outcome === "skipped") {
    return `Gate "${name}" skipped: ${result.reasons.join(" ")}`;
  }
  return `Gate "${name}" held this run. ${result.reasons.join(" ")}`;
}
