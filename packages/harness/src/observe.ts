/**
 * Resolving a Station's workspace so observed paths can be compared to it.
 *
 * Shared ground rather than one harness's private helper: `claude-code` and
 * `codex` both hand their work to a subprocess that reports absolute paths it
 * has already resolved, so both need the same correction before any leash
 * comparison means anything. It lived in `claude-code.ts` until the second
 * harness needed it, and a harness importing another harness is exactly the
 * coupling this package is arranged to prevent.
 */
import { realpath } from "node:fs/promises";
import type { Station } from "@cuesheet/core";

/**
 * The Station, with its workspace resolved through `realpath`.
 *
 * The observing check in {@link fileEvents} runs inside the synchronous
 * stream mapper, so it uses the lexical `checkPath` rather than the async
 * `resolveAndCheck` — which means both sides of the comparison have to
 * already be resolved, or it compares a resolved path against an unresolved
 * one and denies a file that is plainly inside the workspace.
 *
 * That is not a hypothetical. The CLI reports absolute paths it has already
 * resolved, and on macOS `/tmp` and `/var` are symlinks into `/private`, so a
 * workspace at `/tmp/api` sees every one of its own writes arrive as
 * `/private/tmp/api/...` and reported as an escape. A symlinked `~/code` does
 * the same thing on any platform. Resolving once, here, costs one syscall per
 * run and makes every later comparison like-for-like.
 */
export async function observedStation(
  station: Station,
  workspacePath: string,
): Promise<Station> {
  try {
    return { ...station, workspace: await realpath(workspacePath) };
  } catch {
    // A workspace that cannot be resolved is a problem the run will hit on
    // its own terms; the observer falls back to the configured path.
    return { ...station, workspace: workspacePath };
  }
}
