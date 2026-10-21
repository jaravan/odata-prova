// A persistence that keeps the state in memory, as a database would: per set, rows by their
// identity, each commit's deletes applied before its writes (see SetChanges). load() answers
// what was saved, so a second app on the same instance is a restart. delay makes every call
// async for real, for requests to pile up in the queue.

import { setTimeout as sleep } from "node:timers/promises";
import type { Persistence, SetChanges } from "../lib/persistence.ts";
import type { Row } from "../lib/model.ts";

class MemoryPersistence implements Persistence {
  // Rows by identity, per set; undefined until the first commit
  saved: Map<string, Map<string, Row>> | undefined;
  commits = 0;
  closed = false;
  private delay: number;

  constructor({ delay = 0 }: { delay?: number } = {}) {
    this.delay = delay;
  }

  async load(): Promise<Record<string, Row[]> | undefined> {
    await sleep(this.delay);
    this.closed = false;
    return this.saved && this.state();
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

export { MemoryPersistence };
