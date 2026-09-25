/**
 * The run store, in SQLite — one `runs.db` per project.
 *
 * ```
 * ~/.cuesheet/projects/<id>/runs/
 *   runs.db        runs, events and diffs
 *   runs.db-wal    the write-ahead log (WAL mode)
 *   <runId>/       whatever the file store wrote before this one opened
 * ```
 *
 * Step 10 chose files and said why: a native module is the most reliable way
 * to kill a cross-platform Electron build. `node:sqlite` is not a native
 * module — it is compiled into the runtime, in Node 22.13+ and in Electron 44
 * (checked, rather than assumed, because the whole point of the original
 * decision was the packaging risk). Nothing is added to `package.json` and
 * nothing is rebuilt per platform. That is what made the swap cheap enough to
 * take, and it is also why {@link openSqliteRunStore} refuses with an
 * actionable message rather than crashing when the module is absent: an
 * operator on an older Node 22 needs to be told to use the file store, not
 * shown a stack trace about a missing built-in.
 *
 * **What this buys, precisely.** Two queries the file store answers by walking
 * the disk:
 *
 * - `list(limit)` — `readdir` on a directory with ten thousand entries, then
 *   one `readFile` per row rendered. Here it is an index range scan of exactly
 *   `limit` rows.
 * - `unfinished()` — the file store cannot ask it at all, so `reconcile.ts`
 *   scans a bounded window of recent runs and a run stranded further back
 *   stays `running` forever. A partial index answers it outright, at any age.
 *
 * **Everything here is synchronous, and that is deliberate.** `DatabaseSync`
 * blocks the event loop for the duration of a statement, which for a
 * single-row insert into a WAL-mode database is microseconds — far less than
 * the `writeFile` it replaces, which blocks a thread pool slot instead and
 * costs the caller a tick either way. The async `RunStore` signatures are kept
 * because the interface is the seam and a future remote store will need them;
 * the bodies just happen to have nothing to await. One useful consequence:
 * the per-run write chain the file store needs in order to survive concurrent
 * appends is unnecessary here, because a statement cannot interleave with
 * another statement.
 */
import { mkdir, readdir } from "node:fs/promises";
import type * as SqliteModuleTypes from "node:sqlite";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  hostEnv,
  isTerminalStatus,
  runsDir,
  type HostEnv,
  type Run,
  type RunEvent,
  type RunId,
} from "@cuesheet/core";
import { isRunId, nextRunId, type RunIdFactory } from "./ids.js";
import {
  applyRunFinish,
  applyRunUpdate,
  createFileRunStore,
  newRunRecord,
  RunNotFoundError,
  type RunStore,
  type StoredRun,
} from "./store.js";

/** The module itself, for the dynamic import inside {@link openSqliteRunStore}. */
type SqliteModule = typeof SqliteModuleTypes;

/** The database file inside a project's runs directory. */
export const RUNS_DB_FILENAME = "runs.db";

export interface SqliteRunStoreOptions {
  /** Defaults to the real host; tests point `homedir` at a temp directory. */
  env?: HostEnv;
  /** The runs root that holds `runs.db`. Wins over `env`. */
  root?: string;
  newId?: RunIdFactory;
  now?: () => Date;
}

export interface SqliteRunStore extends RunStore {
  unfinished(): Promise<Run[]>;
  close(): Promise<void>;
  /**
   * Run directories imported when this database was created. `0` on every
   * open after the first — an import happens once, and the file store's
   * directories are left where they are.
   */
  readonly importedRuns: number;
  /** `null` when the database was already current and nothing changed. */
  readonly migration: RunsMigration | null;
}

/** Thrown when the runtime has no `node:sqlite` to open. */
export class SqliteUnavailableError extends Error {
  constructor(override readonly cause?: unknown) {
    super(
      "This build of Node has no node:sqlite (added in Node 22.5, unflagged in 22.13). " +
        "Upgrade Node, or run the daemon with CUESHEET_RUN_STORE=files.",
    );
    this.name = "SqliteUnavailableError";
  }
}

/** Thrown when the database on disk is newer than this build understands. */
export class RunsSchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `This run store was written by a newer Cuesheet (schema v${found}; this build reads v${supported}). ` +
        "Upgrade Cuesheet rather than letting an older build write to it.",
    );
    this.name = "RunsSchemaTooNewError";
  }
}

/**
 * Whether this runtime can open a SQLite store at all.
 *
 * Asked before choosing a backend rather than discovered on the first write,
 * because the answer decides which store gets built — see `openRunStore`.
 */
export async function sqliteAvailable(): Promise<boolean> {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

/**
 * One step of the schema, from the version before it to `to`.
 *
 * Applied in order, inside the same transaction as the `user_version` bump —
 * so a database is at a version exactly when that version's statements have
 * all committed, and a crash between the two leaves it at the version before
 * rather than claiming one it does not have.
 */
export interface RunsSchemaMigration {
  readonly to: number;
  readonly sql: string;
}

/**
 * Every schema this store has had, oldest first. A new version is a new entry
 * at the end — never an edit to an old one, because an old one has already
 * run on somebody's disk and editing it changes nothing there.
 *
 * Version 1 keeps `IF NOT EXISTS` because it shipped that way in Step 52; a
 * database at version 1 never runs it again, so the clause is inert history.
 */
export const RUNS_SCHEMA_MIGRATIONS: readonly RunsSchemaMigration[] = [
  {
    to: 1,
    sql: `
  CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL,
    terminal    INTEGER NOT NULL,
    doc         TEXT NOT NULL
  ) WITHOUT ROWID;

  -- Partial, so it holds the handful of live runs rather than every run ever.
  CREATE INDEX IF NOT EXISTS runs_open ON runs (id) WHERE terminal = 0;

  CREATE TABLE IF NOT EXISTS events (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL,
    doc     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS events_by_run ON events (run_id, seq);

  -- Separate from runs so that listing a thousand rows never touches a patch
  -- measured in megabytes. The run view fetches it on demand.
  CREATE TABLE IF NOT EXISTS diffs (
    run_id  TEXT PRIMARY KEY,
    patch   TEXT NOT NULL
  ) WITHOUT ROWID;
`,
  },
];

/**
 * The schema version this build writes, stored in SQLite's own `user_version`.
 *
 * A build that finds a larger number refuses to open the database rather than
 * write to it: an older build writing to a newer schema corrupts it quietly,
 * and a downgrade is exactly when that happens.
 */
export const RUNS_SCHEMA_VERSION =
  RUNS_SCHEMA_MIGRATIONS[RUNS_SCHEMA_MIGRATIONS.length - 1]?.to ?? 0;

/** What opening this database changed, for the daemon's migration log. */
export interface RunsMigration {
  /** `user_version` found on open. `0` is a database SQLite just created. */
  readonly from: number;
  readonly to: number;
  /** Run directories copied in from the file store. */
  readonly imported: number;
  /**
   * Run directories the file store could not read, left on disk and not
   * imported. Counted rather than hidden: they were invisible to the file
   * store too, but an import is the moment someone might ask where they went.
   */
  readonly unreadable: number;
}

export async function openSqliteRunStore(
  options: SqliteRunStoreOptions = {},
): Promise<SqliteRunStore> {
  const env = options.env ?? hostEnv();
  const root = options.root ?? runsDir(env);
  const newId = options.newId ?? nextRunId;
  const now = options.now ?? (() => new Date());

  // Imported here rather than at the top of the file, and this is load-bearing:
  // a static import of a module the runtime does not have takes down every
  // caller of `@cuesheet/daemon` at load time, including the ones that asked
  // for the file store. The type-only import above is erased and costs nothing.
  let sqlite: SqliteModule;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    throw new SqliteUnavailableError(error);
  }

  await mkdir(root, { recursive: true });
  const db: DatabaseSync = new sqlite.DatabaseSync(
    join(root, RUNS_DB_FILENAME),
  );

  // WAL so a reader is never blocked by the run currently streaming into the
  // same database, and `synchronous = NORMAL` because WAL makes that durable
  // across a process crash — which is the failure this store is required to
  // survive. Only a machine-level power loss can lose the last commits, and
  // the file store's `events.jsonl` loses its last line to that too.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");

  const found = readUserVersion(db);
  if (found > RUNS_SCHEMA_VERSION) {
    db.close();
    throw new RunsSchemaTooNewError(found, RUNS_SCHEMA_VERSION);
  }

  // The only asynchronous part, so it happens before the transaction opens:
  // the import is decided by `found`, and reading the directories first means
  // the transaction below is one uninterrupted run of statements.
  const legacy =
    found === 0 ? await readFileRuns(root) : { runs: [], unreadable: 0 };

  // Schema, import and version in one transaction, before a statement is
  // prepared against tables that may not exist yet. Step 52 set `user_version` in autocommit *before* importing, so
  // an import that failed partway left a database that said it was current
  // and held no history — and the next boot, reading that version, skipped
  // the import for good. The history was still on disk and would never be
  // shown again, which is the quietest kind of loss there is. Now the version
  // is only ever written by the same commit as the rows it vouches for.
  let migration: RunsMigration | null = null;
  if (found !== RUNS_SCHEMA_VERSION) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const step of RUNS_SCHEMA_MIGRATIONS) {
        if (step.to > found) db.exec(step.sql);
      }
      importFileRuns(db, legacy.runs);
      db.exec(`PRAGMA user_version = ${String(RUNS_SCHEMA_VERSION)}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
    migration = {
      from: found,
      to: RUNS_SCHEMA_VERSION,
      imported: legacy.runs.length,
      unreadable: legacy.unreadable,
    };
  }

  const statements = {
    insertRun: db.prepare(
      "INSERT INTO runs (id, created_at, status, terminal, doc) VALUES (?, ?, ?, ?, ?)",
    ),
    updateRun: db.prepare(
      "UPDATE runs SET status = ?, terminal = ?, doc = ? WHERE id = ?",
    ),
    selectRun: db.prepare("SELECT doc FROM runs WHERE id = ?"),
    listRuns: db.prepare("SELECT doc FROM runs ORDER BY id DESC LIMIT ?"),
    listOpen: db.prepare(
      "SELECT doc FROM runs WHERE terminal = 0 ORDER BY id DESC",
    ),
    insertEvent: db.prepare("INSERT INTO events (run_id, doc) VALUES (?, ?)"),
    selectEvents: db.prepare(
      "SELECT doc FROM events WHERE run_id = ? ORDER BY seq",
    ),
    upsertDiff: db.prepare(
      "INSERT INTO diffs (run_id, patch) VALUES (?, ?) " +
        "ON CONFLICT(run_id) DO UPDATE SET patch = excluded.patch",
    ),
    selectDiff: db.prepare("SELECT patch FROM diffs WHERE run_id = ?"),
  };

  function writeRun(run: Run): void {
    statements.updateRun.run(
      run.status,
      isTerminalStatus(run.status) ? 1 : 0,
      JSON.stringify(run),
      run.id,
    );
  }

  function readRun(runId: RunId): Run | null {
    const row = statements.selectRun.get(runId);
    return row ? (JSON.parse(String(row["doc"])) as Run) : null;
  }

  function readEvents(runId: RunId): RunEvent[] {
    return statements.selectEvents
      .all(runId)
      .map((row) => JSON.parse(String(row["doc"])) as RunEvent);
  }

  function readDiff(runId: RunId): string | null {
    const row = statements.selectDiff.get(runId);
    return row ? String(row["patch"]) : null;
  }

  function insert(run: Run): void {
    statements.insertRun.run(
      run.id,
      run.createdAt,
      run.status,
      isTerminalStatus(run.status) ? 1 : 0,
      JSON.stringify(run),
    );
  }

  let closed = false;

  return {
    importedRuns: migration?.imported ?? 0,
    migration,

    async create(input) {
      const at = now();
      const run = newRunRecord(input, newId(at), at.toISOString());
      insert(run);
      return run;
    },

    async append(runId, event) {
      // No existence check: the queue streams events for a run it just
      // created, and a foreign key here would turn a late event from a
      // harness that outlived its run into a thrown error in a fire-and-forget
      // call. The file store does the same by appending to a directory it
      // creates on demand.
      statements.insertEvent.run(runId, JSON.stringify(event));
    },

    async update(runId, patch) {
      const current = readRun(runId);
      if (!current) throw new RunNotFoundError(runId);
      const next = applyRunUpdate(current, patch);
      writeRun(next);
      return next;
    },

    async finish(runId, input) {
      const current = readRun(runId);
      if (!current) throw new RunNotFoundError(runId);
      const next = applyRunFinish(current, input, now().toISOString());
      // One transaction, so a crash between the patch and the record cannot
      // leave a diff attached to a run that never ended. The file store
      // cannot promise this across two files and says so.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (input.diff !== undefined) {
          statements.upsertDiff.run(runId, input.diff);
        }
        writeRun(next);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return next;
    },

    async get(runId) {
      const run = readRun(runId);
      if (!run) return null;
      const diff = readDiff(runId);
      const stored: StoredRun = {
        run,
        events: readEvents(runId),
        ...(diff !== null && { diff }),
      };
      return stored;
    },

    async getDiff(runId) {
      if (!isRunId(runId)) return null;
      return readDiff(runId);
    },

    async list(limit) {
      // `-1` is SQLite's "no limit". Run ids are timestamp-prefixed, so
      // ordering by the primary key descending is newest-first and the index
      // is walked backwards for exactly as many rows as were asked for.
      return statements.listRuns
        .all(limit ?? -1)
        .map((row) => JSON.parse(String(row["doc"])) as Run);
    },

    async unfinished() {
      return statements.listOpen
        .all()
        .map((row) => JSON.parse(String(row["doc"])) as Run);
    },

    async close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const value = row?.["user_version"];
  return typeof value === "number" ? value : 0;
}

/** What {@link readFileRuns} found in a runs root. */
interface FileRuns {
  runs: StoredRun[];
  unreadable: number;
}

/**
 * Read the run directories an earlier build wrote, for {@link importFileRuns}.
 *
 * Through the file store rather than re-parsing the layout here: it already
 * tolerates a truncated final line and a stale `.tmp` file, and a second
 * reader of that format would have to learn both. It also skips a directory
 * whose `run.json` does not parse — which the file store has always done
 * silently, and which is counted here so the migration log can say so.
 */
async function readFileRuns(root: string): Promise<FileRuns> {
  const files = createFileRunStore({ root });
  const existing = await files.list();
  const directories = (await readdir(root).catch(() => [])).filter(isRunId);

  const runs: StoredRun[] = [];
  for (const run of existing) {
    const record = await files.get(run.id);
    if (record) runs.push(record);
  }
  return { runs, unreadable: directories.length - runs.length };
}

/**
 * Adopt the run directories an earlier build wrote, once.
 *
 * Without this, switching the default backend would empty every existing
 * operator's run history from the Desk — history that is still sitting on
 * disk, which makes it the worst kind of data loss: invisible, and easy to
 * mistake for the real thing. The beta bar says "no data loss, ever", and an
 * upgrade that silently stops showing a year of runs fails it.
 *
 * Three properties worth stating:
 *
 * - **It runs only when the database is new** — `user_version` 0 on open,
 *   which is true of a file SQLite just created and false of one this build
 *   has written. An import that ran twice would either fail on the primary
 *   key or duplicate every event.
 * - **It runs inside the caller's migration transaction,** together with the
 *   schema and the version bump. A crash halfway leaves a database at version
 *   0 with no rows, and the next boot imports again from a clean slate. Step
 *   52 gave the import its own transaction but bumped the version outside it,
 *   which made "imports again" false; see the note at the call site.
 * - **It copies rather than moves.** The directories stay exactly where they
 *   are, so `CUESHEET_RUN_STORE=files` is still a working answer afterwards
 *   and the operator's escape hatch does not depend on a backup they did not
 *   take. The cost is disk that is now written twice; the alternative is a
 *   one-way door.
 */
function importFileRuns(db: DatabaseSync, runs: readonly StoredRun[]): void {
  if (runs.length === 0) return;
  const insertRun = db.prepare(
    "INSERT INTO runs (id, created_at, status, terminal, doc) VALUES (?, ?, ?, ?, ?)",
  );
  const insertEvent = db.prepare(
    "INSERT INTO events (run_id, doc) VALUES (?, ?)",
  );
  const insertDiff = db.prepare(
    "INSERT INTO diffs (run_id, patch) VALUES (?, ?)",
  );
  for (const record of runs) {
    const { run } = record;
    insertRun.run(
      run.id,
      run.createdAt,
      run.status,
      isTerminalStatus(run.status) ? 1 : 0,
      JSON.stringify(run),
    );
    for (const event of record.events) {
      insertEvent.run(run.id, JSON.stringify(event));
    }
    if (record.diff !== undefined) insertDiff.run(run.id, record.diff);
  }
}
