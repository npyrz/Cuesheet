/**
 * The run store — durable run records on disk.
 *
 * ```
 * ~/.cuesheet/runs/<runId>/
 *   run.json       prompt, stations, status, timestamps, cost totals
 *   events.jsonl   append-only RunEvent log
 *   diff.patch     unified diff, written at the end
 * ```
 *
 * Files, not SQLite, and behind an interface so that stays a decision rather
 * than an assumption: a native module is the most reliable way to kill a
 * cross-platform Electron build, and `RunStore` is the seam that lets beta
 * swap in `node:sqlite` without touching a caller.
 *
 * Two invariants this file exists to hold:
 *
 * - **Writes to one run are serialized.** Concurrent append streams throw
 *   `EBUSY` on Windows, where file locking is stricter than on macOS. Every
 *   write for a given run goes through one promise chain, which also removes
 *   the read-modify-write race on `run.json`.
 * - **A crash leaves a readable record, never a corrupt one.** Two different
 *   mechanisms, because the two files fail differently: `events.jsonl` is
 *   append-only, so a hard kill costs at most a partial final line and the
 *   reader drops it; `run.json` is rewritten in place, so it is written to a
 *   temp file and renamed over the target, which is atomic on both platforms.
 */
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  hostEnv,
  runsDir,
  type Cost,
  type HostEnv,
  type Run,
  type RunEvent,
  type RunId,
  type RunResultSummary,
  type RunStatus,
} from "@cuesheet/core";
import { isRunId, nextRunId, type RunIdFactory } from "./ids.js";

export interface CreateRunInput {
  prompt: string;
  workspace: string;
  kind?: Run["kind"];
  cuesheetId?: string;
  stationIds?: string[];
}

/** A run plus its event log. What `GET /runs/:id` answers with. */
export interface StoredRun {
  run: Run;
  events: RunEvent[];
  /** Contents of `diff.patch`, when the run wrote one. */
  diff?: string;
}

/**
 * What `GET /runs/:id` answers with.
 *
 * Deliberately not `StoredRun`: the patch is omitted and replaced by a flag.
 * Named and exported so the Desk and the route's own tests share one
 * declaration — this shape has already moved once, and two hand-maintained
 * copies of a moving contract is how a client drifts from its server.
 */
export interface RunDetailResponse {
  run: Run;
  events: RunEvent[];
  /** Whether `GET /runs/:id/diff` will return a patch. */
  hasDiff: boolean;
}

/** Fields a non-terminal transition may set. */
export interface RunUpdate {
  status?: RunStatus;
  startedAt?: string;
  cost?: Cost;
}

/** What ends a run. `diff` is the patch text, written to `diff.patch`. */
export interface FinishRunInput {
  status: RunStatus;
  result?: RunResultSummary;
  cost?: Cost;
  error?: string;
  diff?: string;
}

export interface RunStore {
  create(input: CreateRunInput): Promise<Run>;
  append(runId: RunId, event: RunEvent): Promise<void>;
  get(runId: RunId): Promise<StoredRun | null>;
  /**
   * Just `diff.patch`, without reading the event log.
   *
   * The run view fetches the diff separately from the run: a workspace with a
   * large untracked tree produces a patch measured in megabytes, and pushing
   * that through `GET /runs/:id` makes opening a run row expensive for a
   * document most viewings never expand. `null` means the run wrote no patch.
   */
  getDiff(runId: RunId): Promise<string | null>;
  /** Newest first. */
  list(limit?: number): Promise<Run[]>;
  finish(runId: RunId, input: FinishRunInput): Promise<Run>;
  /**
   * The one non-terminal transition: `queued` → `running`, which stamps
   * `startedAt`. Deriving it from the event log instead would mean `list()`
   * opens every `events.jsonl` on disk just to render a row.
   */
  update(runId: RunId, patch: RunUpdate): Promise<Run>;
}

export const ZERO_COST: Cost = { tokensIn: 0, tokensOut: 0 };

export interface FileRunStoreOptions {
  /** Defaults to the real host; tests point `homedir` at a temp directory. */
  env?: HostEnv;
  /** Override the runs root outright. Wins over `env`. */
  root?: string;
  newId?: RunIdFactory;
  now?: () => Date;
}

export function createFileRunStore(
  options: FileRunStoreOptions = {},
): RunStore {
  const env = options.env ?? hostEnv();
  const root = options.root ?? runsDir(env);
  const newId = options.newId ?? nextRunId;
  const now = options.now ?? (() => new Date());

  /**
   * One write chain per run. `prior.then(fn, fn)` runs `fn` whether the
   * previous write settled or rejected — a single failed append must not
   * wedge every subsequent write for that run.
   */
  const tails = new Map<RunId, Promise<unknown>>();

  function serialize<T>(runId: RunId, write: () => Promise<T>): Promise<T> {
    const prior = tails.get(runId) ?? Promise.resolve();
    const result = prior.then(write, write);
    tails.set(
      runId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  function dir(runId: RunId): string {
    return join(root, runId);
  }

  async function readRun(runId: RunId): Promise<Run | null> {
    try {
      const text = await readFile(join(dir(runId), "run.json"), "utf8");
      const raw: unknown = JSON.parse(text);
      return isRun(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * Write `run.json` atomically: temp file, then rename over the target.
   *
   * A plain `writeFile` truncates before it writes, so a process killed in
   * that window leaves an unparseable `run.json` — and because `readRun`
   * treats a parse failure as "no such run", the record does not merely lose
   * its last field, it disappears from `list()` entirely. That is a worse
   * outcome than the truncated `events.jsonl` this store is careful about,
   * and it is the one a crash is most likely to hit, since `finish` is the
   * last thing a run does.
   *
   * A same-directory rename is atomic on both platforms, so a reader sees
   * either the previous record or the new one, never a half-written one.
   */
  async function writeRun(run: Run): Promise<void> {
    const target = join(dir(run.id), "run.json");
    const temp = `${target}.tmp`;
    await writeFile(temp, `${JSON.stringify(run, null, 2)}\n`, "utf8");

    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, target);
        return;
      } catch (error) {
        // On Windows an indexer or antivirus holding the target for a moment
        // surfaces as EPERM/EBUSY rather than a real failure. A short retry
        // is the standard mitigation; it is not a redesign.
        if (attempt >= 3 || !isTransientRename(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }
  }

  async function patchRun(
    runId: RunId,
    apply: (run: Run) => Run,
  ): Promise<Run> {
    const current = await readRun(runId);
    if (!current) throw new RunNotFoundError(runId);
    const next = apply(current);
    await writeRun(next);
    return next;
  }

  return {
    async create(input) {
      const createdAt = now().toISOString();
      const id = newId(now());
      const run: Run = {
        id,
        kind: input.kind ?? "prompt",
        status: "queued",
        prompt: input.prompt,
        stationIds: input.stationIds ?? [],
        workspace: input.workspace,
        createdAt,
        cost: { ...ZERO_COST },
        // `exactOptionalPropertyTypes` is on: assigning a possibly-undefined
        // value to an optional property is an error, so absent means absent.
        ...(input.cuesheetId !== undefined && { cuesheetId: input.cuesheetId }),
      };

      return serialize(id, async () => {
        await mkdir(dir(id), { recursive: true });
        await writeRun(run);
        // Touch the log so a reader never has to distinguish "no events yet"
        // from "run directory is half-created".
        await appendFile(join(dir(id), "events.jsonl"), "", "utf8");
        return run;
      });
    },

    async append(runId, event) {
      await serialize(runId, async () => {
        await mkdir(dir(runId), { recursive: true });
        await appendFile(
          join(dir(runId), "events.jsonl"),
          `${JSON.stringify(event)}\n`,
          "utf8",
        );
      });
    },

    async update(runId, patch) {
      return serialize(runId, () =>
        patchRun(runId, (run) => ({
          ...run,
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.startedAt !== undefined && { startedAt: patch.startedAt }),
          ...(patch.cost !== undefined && { cost: patch.cost }),
        })),
      );
    },

    async finish(runId, input) {
      return serialize(runId, async () => {
        if (input.diff !== undefined) {
          await writeFile(join(dir(runId), "diff.patch"), input.diff, "utf8");
        }
        return patchRun(runId, (run) => ({
          ...run,
          status: input.status,
          finishedAt: now().toISOString(),
          cost: input.cost ?? run.cost,
          ...(input.result !== undefined && { result: input.result }),
          ...(input.error !== undefined && { error: input.error }),
        }));
      });
    },

    async get(runId) {
      const run = await readRun(runId);
      if (!run) return null;
      const events = await readEvents(join(dir(runId), "events.jsonl"));
      const diff = await readOptional(join(dir(runId), "diff.patch"));
      return { run, events, ...(diff !== undefined && { diff }) };
    },

    async getDiff(runId) {
      if (!isRunId(runId)) return null;
      return (await readOptional(join(dir(runId), "diff.patch"))) ?? null;
    },

    async list(limit) {
      let names: string[];
      try {
        names = await readdir(root);
      } catch {
        // No runs directory yet is an empty list, not an error.
        return [];
      }

      // Run ids are timestamp-prefixed and fixed-width, so a reverse lexical
      // sort of the directory names is a newest-first sort. No file is opened
      // to order the list.
      const ids = names.filter(isRunId).sort().reverse();
      const wanted = limit === undefined ? ids : ids.slice(0, limit);

      const runs = await Promise.all(wanted.map((id) => readRun(id)));
      return runs.filter((run): run is Run => run !== null);
    },
  };
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: RunId) {
    super(`No run record for ${runId}`);
    this.name = "RunNotFoundError";
  }
}

/**
 * Parse `events.jsonl`, tolerating a partial final line.
 *
 * A process killed mid-append leaves bytes without a newline. Every line is
 * parsed independently and failures are skipped, so the salvageable prefix of
 * a damaged log is still a usable run record. `\r` is trimmed because a log
 * written on Windows and read anywhere still has to parse.
 */
export async function readEvents(file: string): Promise<RunEvent[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }

  const events: RunEvent[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunEvent(parsed)) events.push(parsed);
    } catch {
      // A truncated tail. Everything before it still counts.
    }
  }
  return events;
}

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function isRunEvent(raw: unknown): raw is RunEvent {
  if (raw === null || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o["t"] === "string" &&
    typeof o["runId"] === "string" &&
    typeof o["at"] === "string"
  );
}

/** Windows-only transients from a rename over a file something else touched. */
function isTransientRename(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function isRun(raw: unknown): raw is Run {
  if (raw === null || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  return (
    typeof o["id"] === "string" &&
    typeof o["status"] === "string" &&
    typeof o["prompt"] === "string"
  );
}
