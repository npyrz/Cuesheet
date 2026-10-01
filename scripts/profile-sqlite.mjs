/**
 * Relocate captured SQLite text using SQLite itself. Replacing bytes in the
 * database would corrupt page lengths, while ignoring WAL would drop the
 * committed runs the capture deliberately stranded with SIGKILL.
 * Keep the schema and rows from the released build; never reconstruct either
 * from the manifest that is supposed to be the independent oracle.
 */
export async function relocateProfileDatabase(file, replace) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    // The released v1 layout. A new released schema extends this list when
    // its own capture arrives; silently skipping a text column is not safe.
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 1)
      throw new Error(
        `Unsupported captured SQLite schema ${version}; extend profile relocation before capturing this release.`,
      );
    const columns = [
      ["runs", "id", "doc"],
      ["events", "seq", "doc"],
      ["diffs", "run_id", "patch"],
    ];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, key, column] of columns) {
        const rows = db.prepare(`SELECT ${key}, ${column} FROM ${table}`).all();
        const update = db.prepare(
          `UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`,
        );
        for (const row of rows) {
          const before = row[column];
          if (typeof before !== "string")
            throw new Error(`Unexpected profile column ${table}.${column}`);
          const after = replace(before, column === "doc");
          if (after !== before) update.run(after, row[key]);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    // Removed paths can remain in free pages after an UPDATE. VACUUM removes
    // them; checkpoint moves all committed rows out of the crash's WAL.
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const check = db.prepare("PRAGMA integrity_check").get();
    if (check.integrity_check !== "ok")
      throw new Error("Captured SQLite profile failed integrity_check");
  } finally {
    db.close();
  }
}
