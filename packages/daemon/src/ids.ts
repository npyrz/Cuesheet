/**
 * Run identifiers.
 *
 * Timestamp-prefixed so a lexical sort of directory names *is* a chronological
 * sort — `list()` returns newest-first off `readdir` alone, without opening a
 * single `run.json`.
 *
 * Two constraints shape the format and both are Windows constraints:
 *
 * - **No `:` and no `.`.** A run id becomes a directory name, and a colon is
 *   illegal in a Windows path. `new Date().toISOString()` is full of them, so
 *   the obvious implementation works on macOS and fails on Windows — the exact
 *   class of bug this plan is organized around.
 * - **A zero-padded counter, not a bare one.** Two runs created in the same
 *   millisecond still have to sort in creation order, and `-10` sorts *before*
 *   `-9` lexically. The padding is what keeps "lexical == chronological" true.
 */
import type { RunId } from "@cuesheet/core";

const COUNTER_WIDTH = 4;
const COUNTER_LIMIT = 10 ** COUNTER_WIDTH;

/**
 * A run id is also a path segment and a URL segment. Anything reaching the
 * filesystem is matched against this first, so `/runs/..%2f..%2fetc` is a 400
 * rather than a directory traversal.
 */
export const RUN_ID_PATTERN = /^\d{8}T\d{9}Z-\d{4}$/;

export function isRunId(value: unknown): value is RunId {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

/** `2026-09-10T14:22:33.104Z` → `20260910T142233104Z`. */
export function compactStamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, "");
}

export type RunIdFactory = (now?: Date) => RunId;

/**
 * A counter-carrying id generator.
 *
 * The counter is per-factory rather than global so a test can assert ordering
 * from a known starting point, and it wraps rather than growing past its
 * padding — at which point the millisecond prefix has almost certainly moved
 * on anyway.
 */
export function createRunIdFactory(startAt = 0): RunIdFactory {
  let counter = startAt;
  return (now = new Date()) => {
    const seq = counter % COUNTER_LIMIT;
    counter += 1;
    return `${compactStamp(now)}-${String(seq).padStart(COUNTER_WIDTH, "0")}`;
  };
}

/** The process-wide generator. Tests build their own. */
export const nextRunId: RunIdFactory = createRunIdFactory();
