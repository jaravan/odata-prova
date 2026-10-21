// Calls an action or function: finds it, reads its parameters, applies the model's rule
// for it (config.json) and answers by its return type. Draft actions go to draft.ts.

import { toInternal, propToInternal } from "./types.ts";
import { HttpError, own, splitTopLevel } from "./query.ts";
import { draftAction } from "./draft.ts";
import { checkIfMatch, renewETag } from "./etag.ts";
import { checkProperty } from "./writes.ts";
import type {
  EntityType,
  ODataResponse,
  Operation,
  Property,
  PropertyValue,
  QueryNode,
  ResponseOptions,
  Row,
} from "./model.ts";
import type { ODataService } from "./service.ts";
import type { RequestHeaders } from "./protocol.ts";

// What an operation is called on: an entity (row) or a collection (rows)
interface Binding {
  setName: string;
  type: EntityType;
  row?: Row;
  rows: readonly Row[];
}

// Neutral value of a (property-shaped) type: the result of an operation that returns no
// entity, since the mock can't compute the real one.
function defaultValue(p: Property, depth = 0): PropertyValue {
  if (p.isCollection) return [];
  if (p.complexType) {
    if (depth > 3) return null; // a complex type that contains itself
    const out: Record<string, PropertyValue> = {};
    for (const c of Object.values(p.complexType.properties))
      out[c.name] = defaultValue(c, depth + 1);
    return out;
  }
  if (p.enumType) return p.enumType.members[0]?.name ?? null;
  switch (p.elementType) {
    case "Edm.Boolean":
      return false;
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
    case "Edm.Double":
    case "Edm.Single":
      return 0;
    case "Edm.Int64":
    case "Edm.Decimal":
      return "0";
    case "Edm.Guid":
      return "00000000-0000-0000-0000-000000000000";
    case "Edm.Date":
      return new Date().toISOString().slice(0, 10);
    case "Edm.DateTimeOffset":
      return new Date().toISOString().replace(/\.\d+Z$/, "Z");
    case "Edm.TimeOfDay":
      return "00:00:00";
    case "Edm.Duration":
      return "PT0S";
    case "Edm.String":
      return "";
    default:
      return null;
  }
}

function operationImport(
  svc: ODataService,
  name: string,
): Operation | undefined {
  return own(svc.operations.imports, name);
}

// The operation `name` (qualified or not) bound to `type` or a base type, on an entity
// or a collection.
function boundOperation(
  svc: ODataService,
  name: string,
  type: EntityType,
  onCollection: boolean,
): Operation | undefined {
  const types = new Set<string>();
  for (
    let t: EntityType | undefined = type;
    t;
    t = t.baseType ? svc.model.entityTypes[t.baseType] : undefined
  )
    types.add(t.fullName);
  // A bound operation has a binding parameter (see parseOperations)
  return svc.operations.bound.find(
    (op) =>
      (op.fullName === name || op.name === name) &&
      types.has(op.binding!.elementType) &&
      op.binding!.isCollection === onCollection,
  );
}

// Parameters: V4 actions from the JSON body, V4 functions from the path (Fn(a=1,b='x')),
// V2 from the query string (?a=1&b='x'). Missing ones are null.
function operationParameters(
  svc: ODataService,
  op: Operation,
  paramText: string | undefined,
  body: unknown,
  query: Record<string, unknown>,
): Record<string, PropertyValue> {
  const params: Record<string, PropertyValue> = {};
  if (svc.protocol.version === "4.0" && op.kind === "action") {
    const input = (body && typeof body === "object" ? body : {}) as Record<
      string,
      unknown
    >;
    // Checked as an entity's body is (see checkFields in writes.ts): a parameter the action
    // doesn't have, or a value of the wrong JSON type, is a 400. A field with an @ is an
    // annotation.
    for (const [name, value] of Object.entries(input)) {
      if (name.includes("@")) continue;
      const p = op.parameters.find((p) => p.name === name);
      if (!p)
        throw new HttpError(
          400,
          `${op.name} has no parameter ${name}`,
          "InvalidParameter",
        );
      checkProperty(p, value);
    }
    for (const p of op.parameters)
      params[p.name] = propToInternal(input[p.name], p);
    return params;
  }
  let raw: Record<string, unknown> = query;
  if (svc.protocol.version === "4.0") {
    raw = {};
    for (const part of splitTopLevel(paramText || "", ",")) {
      const eq = part.indexOf("=");
      if (eq === -1)
        throw new HttpError(400, `Invalid parameter ${part} for ${op.name}`);
      raw[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  for (const p of op.parameters) {
    // Text from the query string or the path (a repeated query parameter isn't supported)
    const text = raw[p.name] as string | undefined;
    if (text === undefined) params[p.name] = null;
    else if (text.startsWith("@"))
      throw new HttpError(
        501,
        `Parameter aliases (${p.name}=${text}) are not supported`,
      );
    else if (p.complexType || p.isCollection)
      params[p.name] = propToInternal(text, p);
    else
      params[p.name] = toInternal(
        svc.protocol.parseLiteral(text).value,
        p.type,
      );
  }
  return params;
}

// binding: { setName, type, row, rows } a bound operation was called on. A V2 import with
// bindsTo gets its entity from the key parameters instead. Logs the call, applies the
// model's rule for the operation if any, and answers per operationResult. An If-Match
// header is checked against the entity's ETag, but none is required, even in strict mode
// (see etag.ts).
function callOperation(
  svc: ODataService,
  method: string,
  op: Operation,
  binding: Binding | undefined,
  paramText: string | undefined,
  body: unknown,
  query: Record<string, unknown>,
  q: QueryNode,
  opts: ResponseOptions,
  headers: RequestHeaders,
): ODataResponse {
  // Checked before the operation runs: an action's changes would stay otherwise
  const rt = op.returnType;
  if (q.apply && !(rt?.entityType && rt.isCollection))
    throw new HttpError(
      400,
      `$apply applies to a collection of entities, which ${op.name} doesn't return`,
    );
  const expected = op.httpMethod || (op.kind === "action" ? "POST" : "GET");
  if (method !== expected)
    throw new HttpError(
      405,
      `${op.name} is ${
        op.kind === "action" ? "an action" : "a function"
      }: call it with ${expected}`,
    );
  const params = operationParameters(svc, op, paramText, body, query);
  if (op.bindsTo) {
    const { type, setName, isCollection } = op.bindsTo;
    if (isCollection)
      binding = { setName, type, rows: svc.store.rows(setName) };
    else {
      const row = svc.store.find(setName, type, svc.keyOf(type, params));
      if (!row) throw new HttpError(404, `${type.name} not found`);
      binding = { setName, type, row, rows: [row] };
    }
  }
  if (binding?.row)
    checkIfMatch(
      svc.model,
      binding.setName,
      binding.row,
      headers,
      svc.etags,
      false,
    );
  const on = binding?.row
    ? ` on ${svc.entityUri(binding.setName, binding.type, binding.row)}`
    : "";
  svc.log(`${op.kind} ${op.name}${on} ${JSON.stringify(params)}`);
  const draftKind = binding
    ? draftAction(svc.model, binding.setName, op)
    : undefined;
  if (binding && draftKind) {
    const row = svc.drafts.action(draftKind, op, binding, params, body);
    return svc.protocol.entity(
      svc,
      row,
      binding.setName,
      binding.type,
      q,
      draftKind === "new" ? 201 : 200,
      undefined,
      opts,
    );
  }
  const rule = svc.rules[op.name];
  if (rule?.set && binding?.row) {
    const values: Row = {};
    for (const [name, value] of Object.entries(rule.set))
      values[name] = propToInternal(value, binding.type.properties[name]);
    svc.store.update(binding.setName, binding.row, values);
    renewETag(svc.store, binding.setName, binding.type, binding.row);
  }
  return operationResult(svc, op, binding, params, q, opts);
}

// Response by return type: none -> 204; the binding's entity type -> that entity (Approve
// returns the order); an entity type whose key the parameters carry -> that entity; any
// other entity type, or a collection of one -> rows of its entity set, query options
// applied; anything else -> defaultValue.
function operationResult(
  svc: ODataService,
  op: Operation,
  binding: Binding | undefined,
  params: Record<string, PropertyValue>,
  q: QueryNode,
  opts: ResponseOptions,
): ODataResponse {
  const rt = op.returnType;
  if (!rt) return { status: 204 };
  if (!rt.entityType)
    return svc.protocol.operationValue(svc, op, rt, defaultValue(rt), opts);

  const type = rt.entityType;
  let setName: string, rows: readonly Row[];
  if (binding && binding.type.fullName === type.fullName) {
    setName = binding.setName;
    rows = binding.row ? [binding.row] : binding.rows;
  } else {
    const found =
      op.entitySet ||
      Object.values(svc.model.entitySets).find(
        (es) => es.entityType === type.fullName,
      )?.name;
    rows = found ? svc.store.rows(found) : [];
    setName = found || type.name; // no entity set of that type: only ever an empty result
  }
  if (rt.isCollection)
    return svc.collectionResponse(rows, setName, type, q, opts);
  let row: Row | undefined = rows[0];
  if (
    !binding &&
    type.keys.length &&
    type.keys.every((k) => params[k] != null)
  ) {
    row = rows.find((r) => svc.store.matchesKey(type, r, params));
    if (!row) throw new HttpError(404, `${type.name} not found`);
  }
  if (!row) return svc.protocol.nullEntity();
  return svc.protocol.entity(svc, row, setName, type, q, 200, undefined, opts);
}

export { operationImport, boundOperation, callOperation };
