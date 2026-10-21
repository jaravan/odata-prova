// What keeps the store's state across restarts: loaded once at startup, and fed each
// outermost commit's changes, net per row, to save in one transaction of its own. Queries
// never go through it: the store in memory answers them all.

import type { EntitySet, Model, Property, Row } from "./model.ts";
import type { Change, Store } from "./store.ts";
import { ADMIN } from "./draft.ts";
import { HttpError } from "./query.ts";
import { propToInternal } from "./types.ts";

// What a commit changed in one set: the rows to write, as they are now, and the rows to
// delete, each by its identity (see identityOf). Deletes go first: an entity deleted and
// created again with the same key in one commit is both.
interface SetChanges {
  set: string;
  written: { key: string; row: Row }[];
  deleted: string[];
}

// What a saved row's fields mean: per set, the columns that identify its rows, and the type
// of each property. Saved with the state, so a metadata.xml changed since can be told from
// it, and the rows adapted (see adapt).
interface Shape {
  sets: Record<
    string,
    { identity: string[]; properties: Record<string, string> }
  >;
}

// What was saved: the rows of every set, and the shape they had (none from a backend that
// doesn't keep one: taken as the current)
interface Saved {
  state: Record<string, Row[]>;
  shape?: Shape;
}

interface Persistence {
  // What was saved, or undefined when there is nothing yet (the store is seeded as without
  // persistence, and that state saved)
  load(model: Model): Promise<Saved | undefined>;
  // Saves one commit's changes, all or none
  commit(changes: SetChanges[]): Promise<void>;
  // Replaces all that was saved with these rows, of this shape, all or none: the first state,
  // one adapted to a changed metadata, a reset
  replace(changes: SetChanges[], shape: Shape): Promise<void>;
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

// The shape of the model's rows (see Shape)
function shapeOf(model: Model): Shape {
  const sets: Shape["sets"] = {};
  for (const es of Object.values(model.entitySets)) {
    const type = model.entityTypes[es.entityType];
    const properties: Record<string, string> = {};
    for (const p of [
      ...Object.values(type.properties),
      ...Object.values(type.hiddenKeys ?? {}),
    ])
      properties[p.name] = p.type;
    sets[es.name] = { identity: identityColumns(model, es.name), properties };
  }
  for (const name of Object.keys(model.linkSets))
    sets[name] = { identity: identityColumns(model, name), properties: {} };
  sets[ADMIN] = { identity: identityColumns(model, ADMIN), properties: {} };
  return { sets };
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

const sameShape = (a: Shape, b: Shape) =>
  JSON.stringify(a) === JSON.stringify(b);

// Rows saved with shape `was`, adapted to the model's: a property that's gone is dropped, a
// new one gets its empty value, one whose type changed is converted (or emptied when its value
// can't be); a set that's gone is dropped, a new one left to its seeded rows. Fields that
// weren't properties (a draft's $draftUUID, an open type's dynamic properties) are kept.
// Changed identity columns, or their types, can't be adapted: the rows would be other rows.
// Returns the adapted state, and what was done, to log.
function adapt(
  model: Model,
  saved: Record<string, Row[]>,
  was: Shape,
): { state: Record<string, Row[]>; notes: string[] } {
  const now = shapeOf(model);
  const state: Record<string, Row[]> = {};
  const notes: string[] = [];
  for (const [set, rows] of Object.entries(saved)) {
    const before = was.sets[set];
    const after = now.sets[set];
    if (!after) {
      notes.push(
        `${set}: no longer in the metadata, ${count(rows.length, "row")} dropped`,
      );
      continue;
    }
    if (!before) {
      state[set] = rows;
      continue;
    }
    const typeOf = (shape: typeof before, c: string) =>
      shape.properties[c] ?? "";
    if (
      JSON.stringify(before.identity) !== JSON.stringify(after.identity) ||
      after.identity.some((c) => typeOf(before, c) !== typeOf(after, c))
    )
      throw new Error(
        `${set}'s rows are told apart by ${after.identity.join(", ")} now, by ${before.identity.join(", ")} when they were saved: start over with --persist-reset`,
      );
    // A link set or the draft administrative data has no properties to adapt
    const es = model.entitySets[set] as EntitySet | undefined;
    const type = es && model.entityTypes[es.entityType];
    const props: Record<string, Property> = type
      ? { ...type.properties, ...(type.hiddenKeys ?? {}) }
      : {};
    const gone = Object.keys(before.properties).filter(
      (p) => !(p in after.properties),
    );
    const added = Object.keys(after.properties).filter(
      (p) => !(p in before.properties),
    );
    const retyped = Object.keys(after.properties).filter(
      (p) =>
        p in before.properties && before.properties[p] !== after.properties[p],
    );
    let emptied = 0;
    state[set] = rows.map((row) => {
      const out = { ...row };
      for (const p of gone) delete out[p];
      for (const p of added) out[p] = propToInternal(undefined, props[p]);
      for (const p of retyped)
        try {
          out[p] = propToInternal(row[p], props[p]);
        } catch {
          out[p] = propToInternal(undefined, props[p]);
          emptied++;
        }
      return out;
    });
    if (gone.length)
      notes.push(
        `${set}: ${gone.join(", ")} no longer in the metadata, dropped`,
      );
    if (added.length) notes.push(`${set}: ${added.join(", ")} new, empty`);
    for (const p of retyped)
      notes.push(
        `${set}: ${p} from ${before.properties[p]} to ${after.properties[p]}`,
      );
    if (emptied)
      notes.push(
        `${set}: ${count(emptied, "value")} couldn't be converted, emptied`,
      );
  }
  for (const set of Object.keys(now.sets))
    if (!(set in saved)) notes.push(`${set}: new in the metadata, seeded`);
  return { state, notes };
}

// Starts persistence on a seeded store: the saved state replaces the seeded one (adapted, when
// the metadata changed since), or, when there is none yet, the seeded one is saved as the
// first. From then on every change has to be in a transaction, for persistence to see it. An
// error is a 503 for every request (see Queue): answering from a state that isn't saved would
// lose what they change.
async function open(
  persistence: Persistence,
  store: Store,
  log: (message: string) => void = () => {},
): Promise<void> {
  const model = store.model;
  const shape = shapeOf(model);
  let saved: Saved | undefined;
  try {
    saved = await persistence.load(model);
  } catch (e) {
    throw new HttpError(
      503,
      `The saved state could not be loaded: ${(e as Error).message}`,
    );
  }
  if (saved && (!saved.shape || sameShape(saved.shape, shape)))
    store.load(saved.state);
  else {
    if (saved) {
      let adapted: ReturnType<typeof adapt>;
      try {
        adapted = adapt(model, saved.state, saved.shape!);
      } catch (e) {
        throw new HttpError(
          503,
          `The saved state could not be used: ${(e as Error).message}`,
        );
      }
      store.load(adapted.state);
      log("The metadata changed since the state was saved:");
      for (const note of adapted.notes) log(`  ${note}`);
    }
    try {
      await persistence.replace(everything(model, store.sets()), shape);
    } catch (e) {
      throw new HttpError(
        503,
        `The ${saved ? "adapted" : "first"} state could not be saved: ${(e as Error).message}`,
      );
    }
  }
  store.transactionsOnly = true;
}

export type { Persistence, Saved, SetChanges, Shape };
export { netChanges, everything, shapeOf, open };
