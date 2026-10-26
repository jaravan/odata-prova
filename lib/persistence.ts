// What keeps the store's state across restarts: loaded once at startup, and fed each
// outermost commit's changes, net per row, to save in one transaction of its own. Queries
// never go through it: the store in memory answers them all.
//
// A backend several servers share (PostgreSQL, see postgres.ts) also hands out what the
// others saved, for each server to catch up with before every request (see sharedTurn): each
// keeps the whole state in memory, as one server does, and they all answer alike.

import type {
  EntitySet,
  Model,
  Property,
  PropertyValue,
  Row,
} from "./model.ts";
import { fingerprint, type Change, type Store } from "./store.ts";
import { regenerationNotes } from "./mock-rules.ts";
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
  // Not the rows' shape, but saved with it: the generated sets as they were generated, so a
  // start can tell the ones no write has changed since, and generate them again when their
  // generation changed (see open): the fingerprints of their rows, while no write has changed
  // them, and of what they were generated from (see Store.generatedFrom)
  mock?: {
    rows: Record<string, string>;
    from: Record<string, string>;
  };
}

// What was saved: the rows of every set, and the shape they had (none from a backend that
// doesn't keep one: taken as the current)
interface Saved {
  state: Record<string, Row[]>;
  shape?: Shape;
}

// What other servers saved since this one last loaded, caught up or committed: their commits,
// in order; or the whole state, when the backend no longer has all of those, or it was
// replaced (a reset, a metadata.xml changed)
type News = { changes: SetChanges[][] } | { state: Saved };

// A commit refused because another server saved first: this one's state is behind. The
// request runs again, caught up (see sharedTurn); one that can't is a 503 to send again.
class StaleError extends HttpError {
  constructor() {
    super(
      503,
      "Another server saved changes at the same time: send the request again",
    );
  }
}

// The saved state is gone, and with it what to catch up with: the database's tables were
// dropped, or its data deleted. This server has to restart, to load what's saved then, or seed
// it anew: /healthz says so meanwhile (see app.ts), for a liveness probe to restart it.
class LostError extends HttpError {
  constructor(detail: string) {
    super(
      503,
      `The saved state is gone (${detail}): this server has to restart, to load it or seed it anew`,
    );
  }
}

interface Persistence {
  // Where it keeps the state, for the startup log: a file's path
  name?: string;
  // What was saved, or undefined when there is nothing yet (the store is seeded as without
  // persistence, and that state saved)
  load(model: Model): Promise<Saved | undefined>;
  // Saves one commit's changes, all or none
  commit(changes: SetChanges[]): Promise<void>;
  // Replaces all that was saved with these rows, of this shape, all or none: the first state,
  // one adapted to a changed metadata, a reset
  replace(changes: SetChanges[], shape: Shape): Promise<void>;
  close(): Promise<void>;
  // A backend several servers share has these three too. commit and replace throw StaleError
  // when another server saved since this one's last load, since or commit.
  // What the other servers saved since
  since?(): Promise<News>;
  // Holds off the other servers' commits until unlock(): for a turn that may write
  lock?(): Promise<void>;
  unlock?(): Promise<void>;
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

// A row as a backend saves it, and back. JSON can't hold INF, -INF and NaN, which Edm.Double
// and Edm.Single can be. They're written as {"$float": "INF"}: no property or field is called
// $float, as OData names start with a letter or an underscore.
const FLOATS: Record<string, number> = {
  INF: Infinity,
  "-INF": -Infinity,
  NaN: NaN,
};
const toJson = (row: unknown) =>
  JSON.stringify(row, (_key, value: unknown) =>
    typeof value === "number" && !Number.isFinite(value)
      ? {
          $float: Number.isNaN(value) ? "NaN" : value > 0 ? "INF" : "-INF",
        }
      : value,
  );
const fromJson = <T = Row>(text: string) =>
  JSON.parse(text, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const tag = (value as { $float?: unknown }).$float;
      if (keys.length === 1 && typeof tag === "string" && tag in FLOATS)
        return FLOATS[tag];
    }
    return value;
  }) as T;

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
  JSON.stringify(a.sets) === JSON.stringify(b.sets);

// The store's generated sets, entity and link sets, that no write has changed, as Shape saves
// them
function mockOf(store: Store): Shape["mock"] {
  const rows: Record<string, string> = {};
  for (const set of [...store.generated, ...store.generatedLinks])
    if (!store.hasChanges(set)) rows[set] = fingerprint(store.rows(set));
  return { rows, from: store.generatedFrom };
}

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
// The saved generated sets no write has changed are generated again, and replaced when their
// rows come out different: the mock rules, --mock-rows or the generator changed (see
// Store.regenerate). The ones with writes are kept.
// reset: the seeded state replaces the saved one, which isn't even read (a reset is what to do
// when it can't be used).
async function open(
  persistence: Persistence,
  store: Store,
  log: (message: string) => void = () => {},
  { reset = false }: { reset?: boolean } = {},
): Promise<void> {
  const model = store.model;
  const shape = shapeOf(model);
  const where = persistence.name ? ` ${persistence.name}` : "";
  let saved: Saved | undefined;
  try {
    saved = await persistence.load(model);
  } catch (e) {
    throw new HttpError(
      503,
      `The saved state could not be loaded: ${(e as Error).message}`,
    );
  }
  if (reset) {
    log(`Saved state: reset in${where}, the rows above saved over it`);
    saved = undefined;
  } else if (!saved)
    log(`Saved state: none in${where} yet, the rows above saved as the first`);
  // What has to be saved whole, if anything: the first state, a reset, an adapted or a
  // regenerated one
  let replace = saved ? undefined : reset ? "reset" : "first";
  if (saved) {
    let adapted: ReturnType<typeof adapt> | undefined;
    if (saved.shape && !sameShape(saved.shape, shape))
      try {
        adapted = adapt(model, saved.state, saved.shape);
      } catch (e) {
        throw new HttpError(
          503,
          `The saved state could not be used: ${(e as Error).message}`,
        );
      }
    // A generated set is as generated when its saved rows are (told before adapt changes
    // them), or isn't saved yet: it keeps the rows just generated. A state saved without
    // fingerprints can't tell: every set is taken as changed.
    const savedMock = saved.shape?.mock;
    const changed = [...store.generated, ...store.generatedLinks].filter(
      (set) =>
        set in saved.state &&
        (!savedMock || savedMock.rows[set] !== fingerprint(saved.state[set])),
    );
    store.load(adapted?.state ?? saved.state);
    store.assumeChanged(changed);
    // What the saved sets were generated from; a set new since, from what it was just now
    if (savedMock)
      store.generatedFrom = { ...store.generatedFrom, ...savedMock.from };
    log(`Saved state: loaded from${where} (the rows above are not used)`);
    if (adapted) {
      log("The metadata changed since the state was saved:");
      for (const note of adapted.notes) log(`  ${note}`);
      replace = "adapted";
    }
    const result = store.regenerate();
    const lines = regenerationNotes(
      store,
      result,
      "--persist-reset to regenerate it",
    );
    if (lines.length) {
      log("The mock rules or the generator changed since the state was saved:");
      for (const line of lines) log(line);
    }
    if (result.regenerated.length) replace ??= "regenerated";
  }
  if (replace)
    try {
      await persistence.replace(everything(model, store.sets()), {
        ...shape,
        mock: mockOf(store),
      });
    } catch (e) {
      // Servers starting at once: the one that saved first did it for all
      if (e instanceof StaleError && !reset) {
        await catchUp(persistence, store);
        log(`Saved state: loaded from${where}, saved first by another server`);
        store.transactionsOnly = true;
        return;
      }
      throw new HttpError(
        503,
        `The ${replace} state could not be saved: ${(e as Error).message}`,
      );
    }
  store.transactionsOnly = true;
}

// Applies another server's commit to the store: its rows written and deleted, by identity. A
// new row goes last, as it did on the server that made it. Committed and settled at once:
// it's saved already.
function apply(store: Store, changes: SetChanges[]): void {
  const sets = store.sets();
  const mark = store.begin();
  for (const { set, written, deleted } of changes) {
    // As load() does: a set the model doesn't have isn't the store's
    if (!(set in sets)) continue;
    const columns = identityColumns(store.model, set);
    const find = (key: string) =>
      store.lookup(set, columns, JSON.parse(key) as PropertyValue[])[0];
    for (const key of deleted) {
      const row = find(key);
      if (row) store.removeRow(set, row);
    }
    for (const { key, row } of written) {
      const mine = find(key);
      if (!mine) {
        store.insert(set, row);
        continue;
      }
      store.update(set, mine, row);
    }
  }
  store.commit(mark);
  store.settle(true);
}

// Brings the store up to what the other servers saved. Saved by a server with another
// metadata.xml, the state can't be this one's: it has to restart, and adapt to it.
async function catchUp(persistence: Persistence, store: Store): Promise<void> {
  let news: News;
  try {
    news = await persistence.since!();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(
      503,
      `The saved state could not be read: ${(e as Error).message}`,
    );
  }
  if ("changes" in news) {
    for (const changes of news.changes) apply(store, changes);
    return;
  }
  const { state, shape } = news.state;
  if (shape && !sameShape(shape, shapeOf(store.model)))
    throw new HttpError(
      503,
      "The saved state was replaced by a server with another metadata.xml: restart this one, to adapt to it",
    );
  store.load(state);
}

// How many times a turn that wasn't expected to write runs again, when it did, and another
// server saved first each time
const RETRIES = 3;

// One turn of the queue on a backend several servers share: the store caught up with what
// they saved, then task. A turn that may write holds their commits off until it ends, so its
// own can't be refused, and a $batch's changesets are saved as they run. One that isn't
// expected to write (a GET) doesn't hold them off: if it writes after all (a function with a
// rule), and another server saved first, it runs again, caught up.
async function sharedTurn<T>(
  persistence: Persistence,
  store: Store,
  task: () => T | Promise<T>,
  writes: boolean,
): Promise<T> {
  if (writes) {
    try {
      await persistence.lock!();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(
        503,
        `The saved state could not be locked: ${(e as Error).message}`,
      );
    }
    try {
      await catchUp(persistence, store);
      return await task();
    } finally {
      await persistence.unlock!();
    }
  }
  for (let attempt = 0; ; attempt++) {
    await catchUp(persistence, store);
    try {
      return await task();
    } catch (e) {
      if (!(e instanceof StaleError) || attempt === RETRIES) throw e;
    }
  }
}

export type { News, Persistence, Saved, SetChanges, Shape };
export {
  netChanges,
  everything,
  shapeOf,
  open,
  sharedTurn,
  LostError,
  StaleError,
  toJson,
  fromJson,
};
