/**
 * Running a hook cue — Step 61.
 *
 * A hook is the operator's own command, run by the daemon between Stations:
 * a formatter, a test run, a notification, a commit. What it buys is parity in
 * the direction that matters. One vendor's CLI has a hooks system and another
 * has a notify shim, and the local models of Phase 9 will never have either;
 * a hook *cue* runs the same command after any Station whatever ran it, because
 * the daemon runs it rather than the harness.
 *
 * Kept out of `harness-executor.ts` because nothing here knows what a harness
 * is — which is the point.
 */
import type { Hook, HookReport, RunStatus } from "@cuesheet/core";
import { run, SpawnError } from "@cuesheet/harness";

export interface HookInput {
  runId: string;
  hook: string;
  /** The Station whose step this cue follows, if any came before it. */
  after?: string;
  /** The run's status so far — `"running"` unless something already ended it. */
  status: RunStatus;
  /**
   * The run's own change so far, as a patch, or `null` when the workspace is
   * not a repository. Its own change, not the workspace's dirty state — the
   * Step 60 distinction — so a hook that reformats "what the run touched"
   * cannot reach the operator's uncommitted work by reading this.
   */
  diff: string | null;
}

export interface HookOutcome {
  report: HookReport;
  /** One sentence for a failed run's error, when the hook failed. */
  error?: string;
}

/** How much of a failing hook's stderr makes it into the run's error. */
const STDERR_TAIL_LINES = 5;

/**
 * Run one hook and say what happened. Never throws: every way a hook can go
 * wrong becomes a `HookReport`, and the executor decides from `on_failure`
 * whether that ends the run.
 */
export async function runHook(options: {
  hook: Hook;
  input: HookInput;
  cwd: string;
  signal: AbortSignal;
  /** Each line the hook prints, as it prints it. */
  onLine: (line: string) => void;
}): Promise<HookOutcome> {
  const { hook, input } = options;
  const started = Date.now();
  const [command, ...args] = hook.command;
  const stderr: string[] = [];
  const report = (
    outcome: HookReport["outcome"],
    exitCode: number | null,
  ): HookReport => ({
    hook: input.hook,
    ...(input.after !== undefined && { after: input.after }),
    outcome,
    exitCode,
    durationMs: Date.now() - started,
  });

  try {
    const result = await run(command ?? "", args, {
      cwd: options.cwd,
      // Both, because they serve different hooks: a shell one-liner reads
      // the environment, a script that wants the patch reads stdin.
      env: {
        ...process.env,
        CUESHEET_RUN_ID: input.runId,
        CUESHEET_HOOK: input.hook,
        ...(input.after !== undefined && { CUESHEET_AFTER: input.after }),
      },
      stdin: `${JSON.stringify(input)}\n`,
      signal: options.signal,
      timeoutMs: hook.timeout_seconds * 1000,
      onStdout: options.onLine,
      onStderr: (line) => {
        stderr.push(line);
        if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
        options.onLine(line);
      },
    });

    if (result.code === 0) return { report: report("ok", 0) };
    // Killed with the run stopping is the run's outcome, not the hook's; the
    // executor sees the aborted signal and lands the run as `stopped`.
    const timedOut = result.killed && !options.signal.aborted;
    const outcome = timedOut ? "timed-out" : "failed";
    const why = timedOut
      ? `did not finish within ${String(hook.timeout_seconds)}s`
      : `exited with ${result.code === null ? `signal ${String(result.signal)}` : `code ${String(result.code)}`}`;
    const tail = stderr.length > 0 ? `: ${stderr.join(" / ")}` : "";
    return {
      report: report(outcome, result.code),
      error: `Hook "${input.hook}" (${hook.command.join(" ")}) ${why}${tail}`,
    };
  } catch (failure) {
    // Not on PATH, not executable, a typo in `command[0]`. The commonest hook
    // failure there is, and the one most worth naming exactly.
    const reason =
      failure instanceof SpawnError
        ? failure.message
        : failure instanceof Error
          ? failure.message
          : String(failure);
    return {
      report: report("not-started", null),
      error: `Hook "${input.hook}" could not start: ${reason}`,
    };
  }
}
