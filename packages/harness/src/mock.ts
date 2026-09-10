/**
 * The `mock` harness — a fake agent that behaves like a real one.
 *
 * Built before the real one, and that ordering is the point. Every layer above
 * a harness (the queue, the run store, the WebSocket fan-out, the tiles, the
 * run log, the standby prompt) needs *something* streaming realistic events
 * through it, and developing those against a live model means waiting seconds
 * per iteration and paying for the privilege.
 *
 * So this is not a stub. It is scripted to exercise the awkward paths the UI
 * has to render and the ones that are easy to get wrong: text arriving in
 * chunks, a tool call, a real file write through the leash, a *denied* write,
 * a standby that blocks until answered, incremental cost, and a diff.
 */
import type {
  Connector,
  ContextFile,
  Harness,
  HarnessProbeResult,
  RunContext,
  RunResult,
  UsageWindow,
} from "./types.js";
import { LeashDeniedError } from "./types.js";

/** Where the mock writes, relative to the workspace. Handy for assertions. */
export const MOCK_OUTPUT_FILE = "cuesheet-mock.md";

/**
 * A path no sane leash allows. Attempting it proves the denial path end to
 * end: the refusal is enforced by the runtime, surfaced as a `denial` event,
 * and does *not* fail the run.
 */
export const MOCK_DENIED_FILE = "../outside-the-workspace.txt";

export interface MockHarnessOptions {
  /** Delay between scripted beats. `0` in tests; a little in the UI. */
  stepMs?: number;
  /** Raise a standby mid-run. On by default — the Desk needs one to render. */
  standby?: boolean;
  /** Skip the deliberate leash denial. */
  denial?: boolean;
  /** Make the run fail, for testing the unhappy path. */
  fail?: boolean;
}

export function createMockHarness(options: MockHarnessOptions = {}): Harness {
  const stepMs = options.stepMs ?? 0;
  const wantStandby = options.standby ?? true;
  const wantDenial = options.denial ?? true;

  const contextFiles: readonly ContextFile[] = [
    { path: "MOCK.md", scope: "project" },
  ];

  return {
    id: "mock",
    vendor: "cuesheet",
    roles: ["engineer", "reviewer", "worker"],

    async probe(): Promise<HarnessProbeResult> {
      // Always available: it is code in this process, so "installed" is not a
      // question, and pretending otherwise would hide the mock from the Desk's
      // Station picker, which is the one place it needs to be visible.
      return { installed: true, authed: true, version: "mock/1" };
    },

    async usage(): Promise<UsageWindow[]> {
      return [];
    },

    contextFiles,

    async writeConnectors(_connectors: readonly Connector[]): Promise<void> {
      // No runtime to configure. Present because M4 must be additive.
    },

    async run(ctx: RunContext): Promise<RunResult> {
      const pause = () => wait(stepMs, ctx.signal);

      ctx.emit({ t: "text", chunk: `Reading the brief: ${ctx.brief}\n` });
      await pause();

      ctx.emit({ t: "tool", name: "list", input: { path: "." } });
      await ctx.workspace.list(".").catch(() => []);
      ctx.meter.record({ tokensIn: 120, tokensOut: 0 });
      await pause();

      if (wantDenial) {
        // The leash refuses, the refusal is *emitted*, and the run continues.
        // A denial is information, not a crash — an agent that tries one bad
        // path and then does its job is a normal, successful run.
        await ctx.workspace
          .write(MOCK_DENIED_FILE, "should never land")
          .catch((error: unknown) => {
            if (!(error instanceof LeashDeniedError)) throw error;
          });
        await pause();
      }

      if (wantStandby) {
        const answer = await ctx.ask(
          `Write ${MOCK_OUTPUT_FILE} in the workspace?`,
          "permission",
        );
        if (answer === "no") {
          ctx.emit({
            t: "text",
            chunk: "Declined — stopping without edits.\n",
          });
          return { status: "done", cost: ctx.meter.total() };
        }
        await pause();
      }

      // Chunked deliberately: one event per line is what the run log has to
      // stitch back together, and a single fat chunk never exercises that.
      for (const line of scriptedOutput(ctx.brief)) {
        ctx.emit({ t: "text", chunk: `${line}\n` });
        ctx.meter.record({ tokensIn: 0, tokensOut: 24 });
        await pause();
      }

      ctx.emit({
        t: "tool",
        name: "write",
        input: { path: MOCK_OUTPUT_FILE },
      });
      await ctx.workspace.write(
        MOCK_OUTPUT_FILE,
        `# Mock run\n\n${ctx.brief}\n\nWritten by the mock harness at ${new Date().toISOString()}.\n`,
      );

      ctx.meter.record({ tokensIn: 0, tokensOut: 40, usd: 0.0012 });

      if (options.fail) {
        return {
          status: "failed",
          cost: ctx.meter.total(),
          error: "The mock harness was asked to fail.",
        };
      }

      return {
        status: "done",
        cost: ctx.meter.total(),
        diff: await ctx.workspace.diff(),
      };
    },
  };
}

/** The default instance, registered by {@link defaultHarnesses}. */
export const mockHarness: Harness = createMockHarness();

function scriptedOutput(brief: string): string[] {
  return [
    "Planning the change.",
    `Brief: ${brief.slice(0, 80)}`,
    "Editing one file.",
    "Done.",
  ];
}

/**
 * Sleep, unless the run was stopped.
 *
 * Rejects with an `AbortError` rather than resolving early, because the queue
 * distinguishes `stopped` from `done` by whether the executor threw. A mock
 * that swallowed the abort would land a stopped run in the list as `done`, and
 * Step 23's shutdown behaviour would look correct while being wrong.
 */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("The run was stopped.");
  error.name = "AbortError";
  return error;
}
