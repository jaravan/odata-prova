// A persistence that keeps the state in memory, as a database would: per set, rows by their
// identity, each commit's deletes applied before its writes (see SetChanges). load() answers
// what was saved, with its shape, so a second app on the same instance is a restart. delay
// makes every call async for real, for requests to pile up in the queue.

import { setTimeout as sleep } from "node:timers/promises";
import {
  LostError,
  StaleError,
  type News,
  type Persistence,
  type Saved,
  type SetChanges,
  type Shape,
} from "../lib/persistence.ts";
import type { Row } from "../lib/model.ts";

class MemoryPersistence implements Persistence {
  // Rows by identity, per set; undefined until the first commit
  saved: Map<string, Map<string, Row>> | undefined;
  shape: Shape | undefined;
  commits = 0;
  closed = false;
  private delay: number;

  constructor({ delay = 0 }: { delay?: number } = {}) {
    this.delay = delay;
  }

  async load(): Promise<Saved | undefined> {
    await sleep(this.delay);
    this.closed = false;
    return (
      this.saved && { state: this.state(), shape: structuredClone(this.shape) }
    );
  }

  async replace(changes: SetChanges[], shape: Shape): Promise<void> {
    await sleep(this.delay);
    if (this.closed) throw new Error("closed");
    this.saved = new Map();
    this.shape = structuredClone(shape);
    await this.commit(changes);
  }

  async commit(changes: SetChanges[]): Promise<void> {
    await sleep(this.delay);
    if (this.closed) throw new Error("closed");
    this.saved ??= new Map();
    for (const { set, written, deleted } of changes) {
      let rows = this.saved.get(set);
      if (!rows) this.saved.set(set, (rows = new Map()));
      for (const key of deleted) rows.delete(key);
      for (const { key, row } of written) rows.set(key, structuredClone(row));
    }
    this.commits++;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  // The saved rows of every set, as copies
  state(): Record<string, Row[]> {
    return Object.fromEntries(
      [...(this.saved ?? [])].map(([set, rows]) => [
        set,
        structuredClone([...rows.values()]),
      ]),
    );
  }
}

// A database several servers share, in memory, as PostgreSQL is (see postgres.ts): the rows,
// and the log of every commit, null for a state replaced. Each server's SharedPersistence
// knows the latest commit it has.
class SharedDatabase {
  saved = new MemoryPersistence();
  log: (SetChanges[] | null)[] = [];
  // Called after a server's since(): another server's commit, saved in between
  between: (() => void) | undefined;
  // The tables dropped: since() finds nothing to catch up with
  gone = false;

  // A commit as another server would save it, behind every server's back
  save(changes: SetChanges[]): void {
    void this.saved.commit(changes);
    this.log.push(changes);
  }
}

class SharedPersistence implements Persistence {
  db: SharedDatabase;
  version = 0;
  sinceCalls = 0;

  constructor(db: SharedDatabase) {
    this.db = db;
  }

  async load(): Promise<Saved | undefined> {
    this.version = this.db.log.length;
    return this.db.saved.load();
  }

  async commit(changes: SetChanges[]): Promise<void> {
    // Checked and logged at once, as under PostgreSQL's lock
    if (this.db.log.length !== this.version) throw new StaleError();
    this.db.log.push(changes);
    this.version++;
    await this.db.saved.commit(changes);
  }

  async replace(changes: SetChanges[], shape: Shape): Promise<void> {
    if (this.db.log.length !== this.version) throw new StaleError();
    this.db.log.push(null);
    this.version++;
    await this.db.saved.replace(changes, shape);
  }

  async since(): Promise<News> {
    this.sinceCalls++;
    if (this.db.gone)
      throw new LostError("the database has no tables any more");
    // The log shorter than what this server has: restored from a backup
    if (this.db.log.length < this.version) {
      this.version = this.db.log.length;
      return { state: (await this.db.saved.load())! };
    }
    const news = this.db.log.slice(this.version);
    this.version = this.db.log.length;
    const between = this.db.between;
    this.db.between = undefined;
    between?.();
    if (news.includes(null)) return { state: (await this.db.saved.load())! };
    return { changes: news as SetChanges[][] };
  }

  lock(): Promise<void> {
    return Promise.resolve();
  }

  unlock(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  state(): Record<string, Row[]> {
    return this.db.saved.state();
  }
}

export { MemoryPersistence, SharedDatabase, SharedPersistence };
