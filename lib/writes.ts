// Creates, updates and deletes entities in the store: required values, deep insert and its
// rollback, and cascading deletes. Drafts write through here too (see draft.ts).

import { propToInternal } from "./types.ts";
import { HttpError } from "./query.ts";
import { renewETag } from "./etag.ts";
import type {
  AnyNavigation,
  EntitySet,
  EntityType,
  Key,
  Model,
  Row,
} from "./model.ts";
import type { Store } from "./store.ts";
import { addLink, unlink } from "./links.ts";

// What the writes use of the service (the ODataService in service.ts)
export interface WriteHost {
  model: Model;
  store: Store;
  entitySet(name: string): { set: EntitySet; type: EntityType };
  keyOf(type: EntityType, row: Row): Key;
  related(
    row: Row,
    type: EntityType,
    nav: AnyNavigation,
  ): { type: EntityType; rows: Row[] };
}

// A Nullable="false" property a write leaves null is a 400. Keys are checked on their own,
// and a property the client may not set (Core.Computed, sap:creatable or sap:updatable
// "false") is left to the server. Only `names` are checked: an update can't fail on a
// value it didn't touch.
function checkRequired(
  entityType: EntityType,
  row: Row,
  names: string[],
  creating: boolean,
): void {
  const settable = creating ? "creatable" : "updatable";
  for (const name of names) {
    const p = entityType.properties[name];
    if (p.nullable || entityType.keys.includes(name)) continue;
    if (p.computed || p.sap?.[settable] === "false") continue;
    if (row[name] === null)
      throw new HttpError(400, `Property ${name} is required`);
  }
}

// A deep insert is all or nothing: when a related entity fails (a duplicate key, an
// invalid value), the rows this request already inserted are removed again.
// draft: a draft may be incomplete until it is activated, so required values aren't checked.
function create(
  svc: WriteHost,
  setName: string,
  entityType: EntityType,
  body: unknown,
  presetValues: Row = {},
  draft = false,
): Row {
  const inserted: { setName: string; type: EntityType; row: Row }[] = [];
  try {
    return insertTree(
      svc,
      setName,
      entityType,
      body,
      presetValues,
      inserted,
      draft,
    );
  } catch (e) {
    for (const { setName, type, row } of inserted.reverse())
      svc.store.remove(setName, type, svc.keyOf(type, row));
    throw e;
  }
}

// inserted: collects { setName, type, row } for every row inserted, for create's rollback
function insertTree(
  svc: WriteHost,
  setName: string,
  entityType: EntityType,
  body: unknown,
  presetValues: Row,
  inserted: { setName: string; type: EntityType; row: Row }[],
  draft: boolean,
): Row {
  if (!body || typeof body !== "object")
    throw new HttpError(400, "Request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const row = svc.store.normalize(entityType, { ...body, ...presetValues });
  for (const k of entityType.keys) {
    if (row[k] === null)
      throw new HttpError(400, `Key property ${k} is required`);
  }
  if (!draft) checkRequired(entityType, row, Object.keys(row), true);
  if (svc.store.find(setName, entityType, svc.keyOf(entityType, row))) {
    throw new HttpError(409, `${entityType.name} with this key already exists`);
  }
  renewETag(svc.model, setName, entityType, row);
  svc.store.insert(setName, row);
  inserted.push({ setName, type: entityType, row });

  // Deep insert: navigation payloads become related entities with the foreign key filled
  // in. V4 sends arrays, V2 either arrays or { results: [...] }.
  for (const nav of Object.values(entityType.navigations)) {
    const payload = fields[nav.name];
    if (!payload) continue;
    const children: unknown[] = nav.isCollection
      ? Array.isArray(payload)
        ? payload
        : (payload as { results?: unknown[] }).results || []
      : [payload];
    const target = svc.entitySet(nav.targetSet);
    const fk = Object.fromEntries(
      nav.join.map(([src, tgt]) => [tgt, row[src]]),
    );
    for (const child of children) {
      const made = insertTree(
        svc,
        nav.targetSet,
        target.type,
        child,
        fk,
        inserted,
        draft,
      );
      if (nav.links) addLink(svc.model, svc.store, nav, row, made);
    }
  }
  return row;
}

// PATCH/MERGE merge the given properties; PUT replaces the entity (absent properties
// become null, or an empty collection). Key properties are immutable either way. Every value is converted before
// any is written, so an invalid one leaves the entity as it was. draft: as for create.
function update(
  svc: WriteHost,
  setName: string,
  entityType: EntityType,
  key: Key,
  body: unknown,
  replace: boolean,
  draft = false,
): Row {
  const row = svc.store.find(setName, entityType, key);
  if (!row) throw new HttpError(404, `${entityType.name} not found`);
  if (!body || typeof body !== "object")
    throw new HttpError(400, "Request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  const changes: Row = {};
  for (const p of Object.values(entityType.properties)) {
    if (entityType.keys.includes(p.name)) continue;
    if (p.name in fields) changes[p.name] = propToInternal(fields[p.name], p);
    else if (replace) changes[p.name] = propToInternal(undefined, p);
  }
  if (!draft) checkRequired(entityType, changes, Object.keys(changes), false);
  return Object.assign(row, changes);
}

// deleting: the rows this DELETE is already removing. Cascades can lead back to one (a
// one-to-one link whose ends both cascade), which is then left to the delete in progress.
function deleteEntity(
  svc: WriteHost,
  setName: string,
  entityType: EntityType,
  key: Key,
  deleting = new Set<Row>(),
): void {
  const row = svc.store.find(setName, entityType, key);
  if (!row) throw new HttpError(404, `${entityType.name} not found`);
  deleting.add(row);
  for (const nav of Object.values(entityType.navigations)) {
    if (!nav.cascadeDelete) continue;
    const { rows, type } = svc.related(row, entityType, nav);
    for (const child of rows)
      if (!deleting.has(child))
        deleteEntity(
          svc,
          nav.targetSet,
          type,
          svc.keyOf(type, child),
          deleting,
        );
  }
  unlink(svc.model, svc.store, setName, row);
  svc.store.remove(setName, entityType, key);
}

export { checkRequired, create, update, deleteEntity };
