/**
 * The migration log — Step 53's "a migration that runs once and is recorded".
 *
 * Step 33's migrations were already idempotent and Step 52's import already ran
 * once; what neither did was leave anything a person could read afterwards.
 * An operator whose Desk suddenly shows a project rooted at their repository,
 * or whose `runs/` directory has a `runs.db` beside it, had no way to learn
 * which build did that, when, or to what. This file is that record.
 *
 * **The log records; it never decides.** Every migration still guards on the
 * state it is about to change — an absent target, a `user_version` — and not
 * on whether a line here says it already ran. Step 33 argued against a marker
 * file because "a marker is a third thing that can disagree with the two it
 * describes", and that argument still holds: a log consulted for decisions
 * would turn a lost or hand-edited line into a migration that runs twice. So
 * this is written after the fact, read by people and by `GET /migrations`, and
 * by nothing that chooses what to do next.
 *
 * **A migration that did nothing writes nothing.** The log is a list of changes,
 * so the second boot over an upgraded profile adds no lines — which is also
 * the property a test can hold it to.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
// The ambient `node:path` for the same reason `migrate.ts` gives: this reaches
// disk, and `pathFor(env)` is for strings about a platform we may not be on.
import nodePath from "node:path";
import { hostEnv, migrationLogFile, type HostEnv } from "./paths.js";

/**
 * What changed. Each kind is one migration a shipped build performs:
 *
 * - `config-move` — Step 33: the alpha `~/.cuesheet/cuesheet.toml` moved to a
 *   project's private config.
 * - `runs-move` — Step 33: the alpha `~/.cuesheet/runs` moved under a project.
 * - `runs-import` — Step 52: a project's file-store history copied into a new
 *   `runs.db`. The directories are left where they were.
 * - `runs-schema` — a `runs.db` brought from one schema version to the next.
 */
export type MigrationKind =
  "config-move" | "runs-move" | "runs-import" | "runs-schema";

export interface MigrationRecord {
  /** ISO timestamp of when the migration finished. */
  at: string;
  /** The Cuesheet version that performed it, as `/health` reports it. */
  build: string;
  kind: MigrationKind;
  /** The project it belonged to, when it belonged to one. */
  project?: string;
  /** A path for a move, a schema version for a schema change. */
  from: string;
  to: string;
  /** One human sentence, for what `from` and `to` cannot say. */
  detail?: string;
}

export interface MigrationLog {
  /** Append one record. Serialized, so two projects migrating at once cannot interleave a line. */
  record(entry: Omit<MigrationRecord, "at" | "build">): Promise<void>;
  /** Every readable record, oldest first. */
  read(): Promise<MigrationRecord[]>;
}

export interface MigrationLogOptions {
  /** The version stamped on every record — the daemon passes its own. */
  build: string;
  env?: HostEnv;
  /** Override the file outright. Wins over `env`. */
  file?: string;
  now?: () => Date;
}

export function createMigrationLog(options: MigrationLogOptions): MigrationLog {
  const env = options.env ?? hostEnv();
  const file = options.file ?? migrationLogFile(env);
  const now = options.now ?? (() => new Date());
  let chain: Promise<unknown> = Promise.resolve();

  return {
    record(entry) {
      const line: MigrationRecord = {
        at: now().toISOString(),
        build: options.build,
        ...entry,
      };
      const next = chain.then(async () => {
        await mkdir(nodePath.dirname(file), { recursive: true });
        await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
      });
      chain = next.catch(() => undefined);
      return next;
    },

    async read() {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch {
        return [];
      }
      // A line that does not parse is skipped rather than fatal: a crash
      // mid-append leaves a truncated last line, and the same tolerance
      // `events.jsonl` gets is the right one for a file nobody decides from.
      const records: MigrationRecord[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) records.push(parsed);
        } catch {
          continue;
        }
      }
      return records;
    },
  };
}

function isRecord(value: unknown): value is MigrationRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["at"] === "string" &&
    typeof v["build"] === "string" &&
    typeof v["kind"] === "string" &&
    typeof v["from"] === "string" &&
    typeof v["to"] === "string"
  );
}
