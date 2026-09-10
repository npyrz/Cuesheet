/**
 * The harness contract, as something executable.
 *
 * The README invites people to write harnesses that live outside this repo.
 * That invitation is worth very little if "does it work?" can only be answered
 * by wiring it into the app and squinting — so the contract ships as a
 * function a third party can call, not as prose in `docs/harnesses.md`.
 *
 * Two halves, because they have very different costs:
 *
 * - {@link harnessContractViolations} is structural and free. It checks the
 *   shape. Anything can run it, including the registry at startup.
 * - {@link exerciseHarness} actually runs the thing against a scratch
 *   workspace with a recording context, and reports what it observed. For the
 *   `mock` harness that costs a millisecond; for `claude-code` it costs money,
 *   which is why the test that calls it is gated on an env var.
 *
 * Note this file imports no test framework. A contract that only runs under
 * one runner is a contract only this repo can use.
 */
import { ROLES, type Cost, type Station } from "@cuesheet/core";
import { createMeter } from "./meter.js";
import { createWorkspace } from "./workspace.js";
import type {
  Harness,
  HarnessEvent,
  RunContext,
  RunResult,
  Workspace,
} from "./types.js";
import type { StandbyAnswer } from "@cuesheet/core";

// ── Structural ──────────────────────────────────────────────────────────────

/**
 * Check a harness's shape. Returns human-readable problems; `[]` means valid.
 *
 * Returns a list rather than throwing on the first fault so someone porting a
 * harness sees everything wrong at once instead of playing whack-a-mole.
 */
export function harnessContractViolations(candidate: unknown): string[] {
  const problems: string[] = [];
  if (candidate === null || typeof candidate !== "object") {
    return ["A harness must be an object."];
  }
  const h = candidate as Partial<Harness>;

  if (typeof h.id !== "string" || h.id.trim() === "") {
    problems.push("`id` must be a non-empty string.");
  }
  if (typeof h.vendor !== "string" || h.vendor.trim() === "") {
    // Not cosmetic: `distinct_vendors = 2` on a Gate is an equality check over
    // this field, so a blank vendor silently defeats the point of Gates.
    problems.push("`vendor` must be a non-empty string.");
  }
  if (!Array.isArray(h.roles) || h.roles.length === 0) {
    problems.push("`roles` must list at least one role.");
  } else {
    for (const role of h.roles) {
      if (!(ROLES as readonly string[]).includes(role)) {
        problems.push(`\`roles\` contains unknown role "${String(role)}".`);
      }
    }
  }
  if (!Array.isArray(h.contextFiles)) {
    problems.push("`contextFiles` must be an array (empty is fine).");
  } else {
    for (const file of h.contextFiles) {
      if (typeof file?.path !== "string" || file.path === "") {
        problems.push("Every `contextFiles` entry needs a `path`.");
      }
      if (file?.scope !== "project" && file?.scope !== "user") {
        problems.push('`contextFiles[].scope` must be "project" or "user".');
      }
    }
  }
  for (const method of ["probe", "usage", "writeConnectors", "run"] as const) {
    if (typeof h[method] !== "function") {
      problems.push(`\`${method}()\` must be a function.`);
    }
  }
  return problems;
}

// ── Behavioural ─────────────────────────────────────────────────────────────

export interface ExerciseOptions {
  /** The Station to run as. Its `workspace` must exist on disk. */
  station: Station;
  brief?: string;
  /** How to answer any standby the harness raises. Defaults to `"go"`. */
  answer?: StandbyAnswer | ((ask: string) => StandbyAnswer);
  signal?: AbortSignal;
}

export interface ExerciseReport {
  result: RunResult;
  events: HarnessEvent[];
  /** Every question the harness asked, in order. */
  asks: string[];
  meterTotal: Cost;
  /** Contract problems observed while running. `[]` means it behaved. */
  violations: string[];
}

/**
 * Run a harness against a recording context and report what it did.
 *
 * The context is the real one — the same `createWorkspace` and `createMeter`
 * the daemon builds — so a harness cannot pass this and fail in the app
 * because the test handed it a friendlier fake.
 */
export async function exerciseHarness(
  harness: Harness,
  options: ExerciseOptions,
): Promise<ExerciseReport> {
  const events: HarnessEvent[] = [];
  const asks: string[] = [];
  const violations = harnessContractViolations(harness);

  const emit = (event: HarnessEvent): void => {
    events.push(event);
  };
  const meter = createMeter({ emit });
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;

  let workspace: Workspace;
  try {
    workspace = createWorkspace({
      station: options.station,
      emit,
      signal,
    });
  } catch (error) {
    violations.push(
      `Could not build a workspace for the Station: ${text(error)}`,
    );
    throw error;
  }

  const ctx: RunContext = {
    runId: "contract-run",
    stationId: options.station.id,
    station: options.station,
    brief: options.brief ?? "Say hello in a new file.",
    workspace,
    emit,
    meter,
    async ask(question) {
      asks.push(question);
      return typeof options.answer === "function"
        ? options.answer(question)
        : (options.answer ?? "go");
    },
    signal,
  };

  const result = await harness.run(ctx);

  if (result === null || typeof result !== "object") {
    violations.push("`run()` must resolve to a RunResult object.");
  } else {
    if (result.status !== undefined && result.status === "running") {
      violations.push("`run()` must not resolve with a non-terminal status.");
    }
    if (result.cost !== undefined) {
      const { tokensIn, tokensOut } = result.cost;
      if (!Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) {
        violations.push("`result.cost` token counts must be finite numbers.");
      }
    }
    if (result.diff !== undefined && typeof result.diff.patch !== "string") {
      violations.push(
        "`result.diff.patch` must be a string when `diff` is set.",
      );
    }
  }

  return { result, events, asks, meterTotal: meter.total(), violations };
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
