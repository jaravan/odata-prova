// Persistence in a SQLite file, through node:sqlite (built into Node, no dependency). The rows
// are documents: one table holds every set's, each as the JSON of the row as memory holds it,
// by set and identity (see persistence.ts), with seq for their order. A metadata.xml that
// changes all the time would make typed columns a migration per change.
//
// node:sqlite is imported on the first load, so a server without persistence never loads it
// (on Node 22 it prints an ExperimentalWarning).

import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Row } from "./model.ts";
import {
  toJson,
  fromJson,
  type Persistence,
  type Saved,
  type SetChanges,
  type Shape,
} from "./persistence.ts";

// The layout of the file; a file of another one isn't read
const FORMAT = "1";

class SqlitePersistence implements Persistence {
  file: string;
  name: string;
  private db: DatabaseSync | undefined;
  private statements:
    | { known: StatementSync; remove: StatementSync; write: StatementSync }
    | undefined;

  constructor(file: string) {
    this.file = file;
    this.name = file;
  }

  // Opens the file, creating it if there's none, and keeps it locked until close(): one
  // server per file, since each keeps its own copy of the state in memory
  async load(): Promise<Saved | undefined> {
    const { DatabaseSync } = await import("node:sqlite");
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.file);
    } catch (e) {
      // SQLite says only "unable to open database file"
      throw new Error(
        `cannot open ${this.file}: ${(e as Error).message} (does its folder exist, and can this process write to it?)`,
        { cause: e },
      );
    }
    try {
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      try {
        // Takes the lock now, rather than at the first write
        db.exec("BEGIN EXCLUSIVE");
      } catch (e) {
        throw /locked|busy/i.test((e as Error).message)
          ? new Error(
              `${this.file} is in use by another process: one server per file`,
            )
          : e;
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rows (
          set_name TEXT NOT NULL,
          key TEXT NOT NULL,
          seq INTEGER NOT NULL,
          row TEXT NOT NULL,
          PRIMARY KEY (set_name, key)
        );
        CREATE INDEX IF NOT EXISTS rows_order ON rows (set_name, seq);
        CREATE TABLE IF NOT EXISTS sets (set_name TEXT PRIMARY KEY);
      `);
      db.exec("COMMIT");
    } catch (e) {
      db.close();
      throw e;
    }
    this.db = db;
    this.statements = {
      // A set with no rows leaves no trace in rows, yet its being empty is state: without it,
      // a set whose rows were all deleted would get its seeded rows back on a restart
      known: db.prepare("INSERT OR IGNORE INTO sets (set_name) VALUES (?)"),
      remove: db.prepare("DELETE FROM rows WHERE set_name = ? AND key = ?"),
      // A new row goes after the set's others; an existing one keeps its seq, as it keeps its
      // place in memory
      write: db.prepare(
        `INSERT INTO rows (set_name, key, seq, row)
         VALUES (?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM rows WHERE set_name = ?), ?)
         ON CONFLICT (set_name, key) DO UPDATE SET row = excluded.row`,
      ),
    };

    const format = db
      .prepare("SELECT value FROM meta WHERE name = 'format'")
      .get() as { value: string } | undefined;
    // No state saved yet: the first commit saves one
    if (!format) return undefined;
    if (format.value !== FORMAT) {
      void this.close();
      throw new Error(
        `${this.file} has format ${format.value}, this version reads ${FORMAT}`,
      );
    }

    const shape = db
      .prepare("SELECT value FROM meta WHERE name = 'shape'")
      .get() as { value: string } | undefined;
    return {
      state: this.state(),
      shape: shape && (JSON.parse(shape.value) as Shape),
    };
  }

  // One database transaction: a commit's deletes, then its writes
  commit(changes: SetChanges[]): Promise<void> {
    return this.transaction(changes);
  }

  // One database transaction too: all that was saved goes, these rows and shape come
  replace(changes: SetChanges[], shape: Shape): Promise<void> {
    return this.transaction(changes, shape);
  }

  private transaction(changes: SetChanges[], shape?: Shape): Promise<void> {
    const db = this.db;
    if (!db || !this.statements)
      return Promise.reject(new Error(`${this.file} is not open`));
    const { known, remove, write } = this.statements;
    db.exec("BEGIN");
    try {
      if (shape) {
        db.exec("DELETE FROM rows; DELETE FROM sets");
        db.prepare(
          "INSERT OR REPLACE INTO meta (name, value) VALUES ('shape', ?)",
        ).run(JSON.stringify(shape));
      }
      for (const { set } of changes) known.run(set);
      for (const { set, deleted } of changes)
        for (const key of deleted) remove.run(set, key);
      for (const { set, written } of changes)
        for (const { key, row } of written)
          write.run(set, key, set, toJson(row));
      db.exec(
        `INSERT OR IGNORE INTO meta (name, value) VALUES ('format', '${FORMAT}')`,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    this.statements = undefined;
    return Promise.resolve();
  }

  // Every set's rows as the file holds them, in their order: for tests, and an export
  state(): Record<string, Row[]> {
    if (!this.db) throw new Error(`${this.file} is not open`);
    const sets = this.db.prepare("SELECT set_name FROM sets").all() as {
      set_name: string;
    }[];
    const state: Record<string, Row[]> = Object.fromEntries(
      sets.map(({ set_name }) => [set_name, []]),
    );
    const rows = this.db
      .prepare("SELECT set_name, row FROM rows ORDER BY set_name, seq")
      .all() as { set_name: string; row: string }[];
    for (const { set_name, row } of rows) state[set_name].push(fromJson(row));
    return state;
  }
}

export { SqlitePersistence };
