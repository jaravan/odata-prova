// Creates, updates and deletes entities in the store: required values, deep insert and its
// rollback, links to existing entities (see references.ts), and cascading deletes. Drafts
// write through here too (see draft.ts).

import { isNumericType, propToInternal } from "./types.ts";
import { HttpError, own } from "./query.ts";
import { nextETag } from "./etag.ts";
import type {
  AnyNavigation,
  ComplexType,
  EntitySet,
  EntityType,
  Key,
  Model,
  Navigation,
  Row,
  TypedElement,
} from "./model.ts";
import type { Store } from "./store.ts";
import { addLink, unlink } from "./links.ts";
import {
  changeable,
  link,
  resolveReference,
  type ReferenceHost,
} from "./references.ts";

// What the writes use of the service (the ODataService in service.ts)
export interface WriteHost extends ReferenceHost {
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

// V2's reference to an entity in a body: {"__metadata": {"uri": "Photos(2)"}} and nothing else
function isUri(value: unknown): value is { __metadata: { uri: string } } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const meta = (value as { __metadata?: { uri?: unknown } }).__metadata;
  return keys.length === 1 && typeof meta?.uri === "string";
}

// The links a body sets to existing entities: Nav@odata.bind (V4: a URL, or a list of them
// for a collection), or, in a V2 create, a navigation holding only references. field: the
// body's field the link came from.
function bindsOf(
  svc: WriteHost,
  type: EntityType,
  fields: Record<string, unknown>,
): { field: string; nav: Navigation; targets: Row[] }[] {
  const out: { field: string; nav: Navigation; targets: Row[] }[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const bind = /^(.+)@odata\.bind$/.exec(field);
    let name: string, urls: unknown;
    if (bind) [name, urls] = [bind[1], value];
    else {
      // V2: {"Nav": {"__metadata": {"uri": ...}}}, or a list (or {results}) of them
      const list = Array.isArray(value)
        ? value
        : (value as { results?: unknown[] } | null)?.results;
      if (!own(type.navigations, field)) continue;
      if (isUri(value)) [name, urls] = [field, value.__metadata.uri];
      else if (Array.isArray(list) && list.length && list.every(isUri))
        [name, urls] = [field, list.map((u) => u.__metadata.uri)];
      else continue;
    }
    const nav = own(type.navigations, name);
    if (!nav)
      throw new HttpError(
        400,
        `${name} is not a navigation of ${type.name}`,
        "InvalidReference",
      );
    changeable(type, nav);
    if (nav.isCollection !== Array.isArray(urls))
      throw new HttpError(
        400,
        `${field} must be ${nav.isCollection ? "a list of URLs" : "one URL"}`,
        "InvalidReference",
      );
    const targets = (Array.isArray(urls) ? urls : [urls]).map((url: unknown) =>
      resolveReference(svc, url, nav),
    );
    out.push({ field, nav, targets });
  }
  return out;
}

// A link's foreign key on the entity's own side, as values to create it with
function boundValues(binds: ReturnType<typeof bindsOf>): Row {
  const values: Row = {};
  for (const { nav, targets } of binds)
    if (!nav.links && nav.dependentSide === "source")
      for (const [src, tgt] of nav.join) values[src] = targets[0][tgt];
  return values;
}

// A body is checked against its type before anything in it is converted, as a real service
// does: a field the type doesn't have, or a value of the wrong JSON type (123 for a string,
// "true" for a boolean), is a 400. The conversion alone would drop the one and store the
// other as "123", since it also reads CSV cells, where every value is a string. A field
// with an @ is an annotation (@odata.etag, Nav@odata.bind), and __metadata is V2's.
// An open type may hold undeclared properties, and so may a value naming its own type with
// @odata.type (a derived type's): those are let through, and not stored, as before.
function checkFields(
  type: EntityType | ComplexType,
  fields: Record<string, unknown>,
): void {
  const open = type.openType || "@odata.type" in fields;
  for (const [name, value] of Object.entries(fields)) {
    if (name.includes("@") || name === "__metadata") continue;
    if ("navigations" in type) {
      if (own(type.navigations, name)) continue;
      if (type.disabledNavigations && own(type.disabledNavigations, name))
        continue;
    }
    const prop = own(type.properties, name);
    if (!prop && open) continue;
    if (!prop)
      throw new HttpError(
        400,
        `${type.name} has no property ${name}`,
        "InvalidProperty",
      );
    checkProperty(prop, value);
  }
}

// A property's value in a body, or an action parameter's (see operations.ts): a collection
// is an array, and each of its items is checked
function checkProperty(prop: TypedElement, value: unknown): void {
  if (prop.isCollection && value !== null && !Array.isArray(value))
    throw new HttpError(400, `${prop.name}: expected an array`, "InvalidValue");
  for (const v of prop.isCollection ? (value as unknown[]) || [] : [value])
    checkValue(prop, v);
}

// Numbers may come as strings: Int64 and Decimal do in V2 and with IEEE754Compatible, and
// V2 clients send the others so too. Whether the text is a number is the conversion's check.
// A string longer than its MaxLength is a 400 too, as CAP has it ("max" has no limit).
function checkValue(prop: TypedElement, value: unknown): void {
  if (value === null) return;
  // A complex type's value, or an entity's (an action's parameter can be one)
  const structured = prop.complexType || prop.entityType;
  if (structured) {
    if (typeof value !== "object" || Array.isArray(value))
      throw new HttpError(
        400,
        `${prop.name}: expected an object`,
        "InvalidValue",
      );
    checkFields(structured, value as Record<string, unknown>);
    return;
  }
  const max = Number(prop.maxLength);
  if (
    prop.elementType === "Edm.String" &&
    typeof value === "string" &&
    [...value].length > max
  )
    throw new HttpError(
      400,
      `${prop.name}: longer than its MaxLength of ${max}`,
      "InvalidValue",
    );
  const expected =
    prop.elementType === "Edm.Boolean"
      ? ["boolean"]
      : isNumericType(prop.elementType)
        ? ["number", "string"]
        : ["string"];
  if (!expected.includes(typeof value))
    throw new HttpError(
      400,
      `${prop.name}: expected ${expected.map((t) => `a ${t}`).join(" or ")}, got ${JSON.stringify(value)}`,
      "InvalidValue",
    );
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
    // A hidden key (see hiddenKey in navigations.ts) is the server's, never required
    if (!p || p.nullable || entityType.keys.includes(name)) continue;
    if (p.computed || p.sap?.[settable] === "false") continue;
    if (row[name] === null)
      throw new HttpError(
        400,
        `Property ${name} is required`,
        "RequiredProperty",
      );
  }
}

// A deep insert is all or nothing: when a related entity fails (a duplicate key, an
// invalid value), what this create already changed is rolled back.
// draft: a draft may be incomplete until it is activated, so required values aren't checked.
function create(
  svc: WriteHost,
  setName: string,
  entityType: EntityType,
  body: unknown,
  presetValues: Row = {},
  draft = false,
): Row {
  const mark = svc.store.begin();
  try {
    const row = insertTree(svc, setName, entityType, body, presetValues, draft);
    svc.store.commit(mark);
    return row;
  } catch (e) {
    svc.store.rollback(mark);
    throw e;
  }
}

function insertTree(
  svc: WriteHost,
  setName: string,
  entityType: EntityType,
  body: unknown,
  presetValues: Row,
  draft: boolean,
): Row {
  if (!body || typeof body !== "object")
    throw new HttpError(400, "Request body must be a JSON object");
  const fields = body as Record<string, unknown>;
  checkFields(entityType, fields);
  // Links to existing entities: a foreign key on this side before the required values are
  // checked, the others once the entity exists
  const binds = bindsOf(svc, entityType, fields);
  const row = svc.store.normalize(entityType, {
    ...body,
    ...boundValues(binds),
    ...presetValues,
  });
  for (const k of entityType.keys) {
    if (row[k] === null)
      throw new HttpError(
        400,
        `Key property ${k} is required`,
        "RequiredProperty",
      );
  }
  if (!draft) checkRequired(entityType, row, Object.keys(row), true);
  if (svc.store.find(setName, entityType, svc.keyOf(entityType, row))) {
    throw new HttpError(
      409,
      `${entityType.name} with this key already exists`,
      "DuplicateKey",
    );
  }
  Object.assign(row, nextETag(svc.model, setName, entityType, row));
  svc.store.insert(setName, row);

  // Deep insert: navigation payloads become related entities with the foreign key filled
  // in. V4 sends arrays, V2 either arrays or { results: [...] }.
  for (const nav of Object.values(entityType.navigations)) {
    const payload = fields[nav.name];
    if (!payload || binds.some((b) => b.field === nav.name)) continue;
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
        draft,
      );
      if (nav.links) addLink(svc.model, svc.store, nav, row, made);
    }
  }
  for (const { nav, targets } of binds)
    if (nav.links || nav.dependentSide === "target")
      for (const target of targets)
        link(svc, setName, entityType, row, nav, target);
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
  checkFields(entityType, fields);
  const changes: Row = {};
  for (const p of Object.values(entityType.properties)) {
    if (entityType.keys.includes(p.name)) continue;
    if (p.name in fields) changes[p.name] = propToInternal(fields[p.name], p);
    else if (replace) changes[p.name] = propToInternal(undefined, p);
  }
  if (!draft) checkRequired(entityType, changes, Object.keys(changes), false);
  // Links to existing entities: a single-valued navigation's instead of the one before, a
  // collection's besides the others. Resolved before anything changes, so a bad one changes
  // nothing.
  const binds = bindsOf(svc, entityType, fields);
  svc.store.update(setName, row, changes);
  for (const { nav, targets } of binds)
    for (const target of targets)
      link(svc, setName, entityType, row, nav, target);
  return row;
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

export { checkProperty, checkRequired, create, update, deleteEntity };
