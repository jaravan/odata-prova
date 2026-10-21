// What keeps the store's state across restarts: loaded once at startup, and fed each
// outermost commit's changes, net per row, to save in one transaction of its own. Queries
// never go through it: the store in memory answers them all.

import type { Model, Row } from "./model.ts";
import type { Change, Store } from "./store.ts";
import { ADMIN } from "./draft.ts";
import { HttpError } from "./query.ts";

// What a commit changed in one set: the rows to write, as they are now, and the rows to
// delete, each by its identity (see identityOf). Deletes go first: an entity deleted and
// created again with the same key in one commit is both.
interface SetChanges {
  set: string;
  written: { key: string; row: Row }[];
  deleted: string[];
}

interface Persistence {
  // The saved state, or undefined when there is none yet (the store is seeded as without
  // persistence, and that state saved)
  load(model: Model): Promise<Record<string, Row[]> | undefined>;
  // Saves one commit's changes, all or none
  commit(changes: SetChanges[]): Promise<void>;
  close(): Promise<void>;
}

// The columns that tell a set's rows apart: an entity's keys, with a contained entity's
// parent's (see parentKeys); a link's columns, all of them, as a link has no key of its own;
// a draft's administrative data's DraftUUID
function identityColumns(model: Model, setName: string): string[] {
  const es = model.entitySets[setName];
  if (es) {
    const type = model.entityTypes[es.entityType];
    return [...new Set([...type.keys, ...(type.parentKeys ?? [])])];
  }
  const links = model.linkSets[setName];
  if (links) return links.ends.flatMap((end) => end.columns);
  if (setName === ADMIN) return ["DraftUUID"];
  throw new Error(`no identity for the rows of ${setName}`);
}

function identityOf(columns: string[], row: Row): string {
  return JSON.stringify(columns.map((c) => row[c]));
}

// The net effect of an outermost commit's changes (see Store.commit), per set in the order
// they were first changed: a row changed several times is written once, as it is now; a row
// inserted and removed again is nothing. Rows are copied: what's handed out doesn't change
// with the store.
function netChanges(model: Model, changes: Change[]): SetChanges[] {
  // Per row object, whether it was there before the commit, and whether it is after
  const rows = new Map<Row, { set: string; before: boolean; after: boolean }>();
  const columns = new Map<string, string[]>();
  for (const c of changes) {
    if (!columns.has(c.set)) columns.set(c.set, identityColumns(model, c.set));
    if (c.op === "update")
      for (const name of columns.get(c.set)!)
        if (name in c.before && String(c.before[name]) !== String(c.row[name]))
          throw new Error(
            `${c.set}: ${name} changed, which identifies the row, from ${String(c.before[name])} to ${String(c.row[name])}`,
          );
    const seen = rows.get(c.row);
    if (seen) seen.after = c.op !== "remove";
    else
      rows.set(c.row, {
        set: c.set,
        before: c.op !== "insert",
        after: c.op !== "remove",
      });
  }

  const bySet = new Map<string, SetChanges>();
  for (const [row, { set, before, after }] of rows) {
    if (!before && !after) continue;
    let out = bySet.get(set);
    if (!out) bySet.set(set, (out = { set, written: [], deleted: [] }));
    const key = identityOf(columns.get(set)!, row);
    if (after) out.written.push({ key, row: structuredClone(row) });
    else out.deleted.push(key);
  }
  return [...bySet.values()];
}

// Every row of every set, written: the first state saved, when there is none yet
function everything(
  model: Model,
  sets: Readonly<Record<string, readonly Row[]>>,
): SetChanges[] {
  return Object.entries(sets).map(([set, rows]) => {
    const columns = identityColumns(model, set);
    return {
      set,
      written: rows.map((row) => ({
        key: identityOf(columns, row),
        row: structuredClone(row),
      })),
      deleted: [],
    };
  });
}

// Starts persistence on a seeded store: the saved state replaces the seeded one, or, when
// there is none yet, the seeded one is saved as the first. From then on every change has to
// be in a transaction, for persistence to see it. An error is a 503 for every request (see
// Queue): answering from a state that isn't saved would lose what they change.
async function open(persistence: Persistence, store: Store): Promise<void> {
  let state: Record<string, Row[]> | undefined;
  try {
    state = await persistence.load(store.model);
  } catch (e) {
    throw new HttpError(
      503,
      `The saved state could not be loaded: ${(e as Error).message}`,
    );
  }
  if (state) store.load(state);
  else
    try {
      await persistence.commit(everything(store.model, store.sets()));
    } catch (e) {
      throw new HttpError(
        503,
        `The first state could not be saved: ${(e as Error).message}`,
      );
    }
  store.transactionsOnly = true;
}

export type { Persistence, SetChanges };
export { netChanges, everything, open };
