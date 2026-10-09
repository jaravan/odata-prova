// v4 response characteristics: @odata.context/@odata.count/value, plain ISO dates,
// bare URL literals with no type prefix (2025-01-20, raw GUIDs), $count=true, $search, and
// $expand with its own options nested in parens.
import type {
  EntityType,
  Literal,
  ODataResponse,
  Property,
  PropertyValue,
  QueryNode,
  ResponseOptions,
  Row,
} from "../model.ts";
import type { ODataService, Protocol } from "../service.ts";
import { toInternal, specialFloat } from "../types.ts";
import {
  HttpError,
  newNode,
  addExpandPath,
  addSelectPath,
  checkSelect,
  splitTopLevel,
  parseInt10,
  rejectUnsupported,
} from "../query.ts";

const version = "4.0";
const headers: Record<string, string> = { "OData-Version": "4.0" };
const typedLiteralPrefixes = new Set(["duration", "binary"]);

const GUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
const DATETIMEOFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?/;
const DATE = /^\d{4}-\d{2}-\d{2}/;
const TIME = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?/;

// Bare literals that can start with a letter or a digit. The $filter tokenizer tries this
// before words and numbers. Returns { value, type, length } or undefined.
function matchBareLiteral(
  text: string,
): (Literal & { length: number }) | undefined {
  let m: RegExpMatchArray | null;
  if ((m = text.match(GUID)))
    return { value: m[0], type: "Edm.Guid", length: m[0].length };
  if ((m = text.match(DATETIMEOFFSET)))
    return {
      value: toInternal(m[0], "Edm.DateTimeOffset"),
      type: "Edm.DateTimeOffset",
      length: m[0].length,
    };
  if ((m = text.match(DATE)))
    return { value: m[0], type: "Edm.Date", length: m[0].length };
  if ((m = text.match(TIME)))
    return {
      value: toInternal(m[0], "Edm.TimeOfDay"),
      type: "Edm.TimeOfDay",
      length: m[0].length,
    };
  return undefined;
}

// URL / $filter literal -> { value (internal), type }.
function parseLiteral(text: string): Literal {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^'((?:[^']|'')*)'$/)))
    return { value: m[1].replace(/''/g, "'"), type: "Edm.String" };
  if (t === "true" || t === "false")
    return { value: t === "true", type: "Edm.Boolean" };
  if (t === "null") return { value: null, type: null };
  if ((m = t.match(/^duration'([^']*)'$/i)))
    return { value: m[1], type: "Edm.Duration" };
  if ((m = t.match(/^binary'([^']*)'$/i)))
    return { value: m[1], type: "Edm.Binary" };
  const bare = matchBareLiteral(t);
  if (bare && bare.length === t.length)
    return { value: bare.value, type: bare.type };
  // Numbers. Decimal/Int64 literals stay strings internally, so keep the text when it has a
  // fraction and let the comparison coerce. The property's type prevails
  if (/^-?\d+$/.test(t)) return { value: Number(t), type: "Edm.Int32" };
  if (/^-?\d+\.\d+$/.test(t)) return { value: t, type: "Edm.Decimal" };
  if (/^-?\d+(?:\.\d+)?[eE][+-]?\d+$/.test(t))
    return { value: Number(t), type: "Edm.Double" };
  if (/^-?\d+(?:\.\d+)?[lLmMdDfF]$/.test(t))
    return { value: t.slice(0, -1), type: "Edm.Decimal" };
  throw new HttpError(400, `Cannot parse literal: ${text}`);
}

// Internal -> key literal in a URL. Only strings are quoted in V4.
function keyLiteral(value: PropertyValue, prop: Property): string {
  return prop.type === "Edm.String"
    ? `'${String(value).replace(/'/g, "''")}'`
    : String(value);
}

// Fractional seconds cut or padded to the property's Precision facet. Without a facet the
// precision is 0 (CSDL), and strict clients such as UI5's V4 model reject any fraction.
function withPrecision(
  value: PropertyValue,
  precision: string | undefined,
): string {
  const digits = Number(precision) || 0;
  return String(value).replace(
    /(:\d{2})(?:\.(\d+))?(?=Z|[+-]\d{2}:\d{2}|$)/,
    (_: string, sec: string, frac = "") =>
      digits ? `${sec}.${frac.padEnd(digits, "0").slice(0, digits)}` : sec,
  );
}

// Internal -> V4 JSON value: arrays for collections, objects for complex types (converted
// field by field), member names for enums. Int64/Decimal go out as strings when the client
// asked for IEEE754Compatible=true (UI5's V4 model always does), as numbers otherwise.
// Returns a JSON value.
function toWire(
  value: PropertyValue | undefined,
  prop: Property,
  opts: Partial<ResponseOptions> = {},
): unknown {
  if (value === null || value === undefined) return null;
  if (prop.isCollection)
    return (value as PropertyValue[]).map((v) => elementToWire(v, prop, opts));
  return elementToWire(value, prop, opts);
}

function elementToWire(
  value: PropertyValue,
  prop: Property,
  opts: Partial<ResponseOptions>,
): unknown {
  if (value === null || value === undefined) return null;
  if (prop.complexType) {
    const fields = value as Record<string, PropertyValue>;
    const out: Record<string, unknown> = {};
    for (const p of Object.values(prop.complexType.properties))
      out[p.name] = toWire(fields[p.name], p, opts);
    return out;
  }
  const type = prop.elementType || prop.type;
  if (specialFloat(value)) return specialFloat(value);
  if ((type === "Edm.Int64" || type === "Edm.Decimal") && !opts.ieee754)
    return Number(value);
  if (type === "Edm.DateTimeOffset" || type === "Edm.TimeOfDay")
    return withPrecision(value, prop.precision);
  return value;
}

// "$expand=Items($select=Material;$top=2;$expand=PurchaseOrder),Other" -> node tree.
function parseExpand(text: string | undefined, node: QueryNode): void {
  for (const item of splitTopLevel(text || "", ",")) {
    const m = item.match(/^([^(]+?)\s*(?:\((.*)\))?$/s);
    if (!m) throw new HttpError(400, `Invalid $expand: ${item}`);
    const child = addExpandPath(node, m[1]);
    if (m[2] !== undefined) applyNestedOptions(child, m[2]);
  }
}

function applyNestedOptions(node: QueryNode, text: string): void {
  for (const opt of splitTopLevel(text, ";")) {
    const eq = opt.indexOf("=");
    if (eq === -1) throw new HttpError(400, `Invalid $expand option: ${opt}`);
    const name = opt.slice(0, eq).trim(),
      value = opt.slice(eq + 1).trim();
    switch (name) {
      case "$select":
        for (const p of splitTopLevel(value, ",")) addSelectPath(node, p);
        break;
      case "$expand":
        parseExpand(value, node);
        break;
      case "$filter":
        node.filter = value;
        break;
      case "$orderby":
        node.orderby = value;
        break;
      case "$top":
        node.top = parseInt10(value, "$top");
        break;
      case "$skip":
        node.skip = parseInt10(value, "$skip");
        break;
      case "$count":
        node.count = value === "true";
        break;
      case "$search":
        node.search = value;
        break;
      default:
        throw new HttpError(400, `Unsupported $expand option: ${name}`);
    }
  }
}

function parseQueryOptions(query: Record<string, unknown>): QueryNode {
  rejectUnsupported(query);
  // Query string values are text (a repeated option isn't supported)
  const q = query as Record<string, string | undefined>;
  const root = newNode();
  parseExpand(q.$expand, root);
  if (q.$select)
    for (const p of splitTopLevel(q.$select, ",")) addSelectPath(root, p);
  return {
    filter: q.$filter,
    orderby: q.$orderby,
    top: parseInt10(q.$top, "$top"),
    skip: parseInt10(q.$skip, "$skip"),
    count: q.$count === "true",
    search: q.$search,
    select: root.select,
    expand: root.expand,
  };
}

function serialize(
  svc: ODataService,
  row: Row,
  setName: string,
  type: EntityType,
  node: QueryNode,
  opts?: ResponseOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const selectAll = !node.select || node.select.has("*");
  for (const p of Object.values(type.properties)) {
    if (selectAll || node.select?.has(p.name))
      out[p.name] = toWire(row[p.name], p, opts);
  }
  for (const [navName, child] of Object.entries(node.expand)) {
    const nav = svc.navigation(type, navName);
    if (!nav)
      throw new HttpError(
        400,
        `${navName} is not a navigation property of ${type.name}`,
      );
    const {
      rows,
      count,
      type: targetType,
    } = svc.expandRows(row, type, nav, child);
    const nested = (r: Row) =>
      serialize(svc, r, nav.targetSet, targetType, child, opts);
    if (nav.isCollection) {
      if (child.count) out[`${navName}@odata.count`] = count;
      out[navName] = rows.map(nested);
    } else {
      out[navName] = rows[0] ? nested(rows[0]) : null;
    }
  }
  return out;
}

function json(
  status: number,
  body: unknown,
  opts: Partial<ResponseOptions> = {},
  extra?: Record<string, string>,
): ODataResponse {
  const ieee = opts.ieee754 ? ";IEEE754Compatible=true" : "";
  return {
    status,
    body,
    contentType: `application/json;odata.metadata=minimal${ieee}`,
    headers: extra,
  };
}

const v4: Protocol = {
  version,
  headers,
  typedLiteralPrefixes,
  matchBareLiteral,
  parseLiteral,
  keyLiteral,
  parseQueryOptions,
  serviceDocument(svc) {
    return json(200, {
      "@odata.context": `${svc.servicePath}/$metadata`,
      value: Object.keys(svc.model.entitySets).map((name) => ({
        name,
        kind: "EntitySet",
        url: name,
      })),
    });
  },
  collection(svc, { rows, count }, setName, type, node, opts) {
    checkSelect(svc, type, node);
    const body: Record<string, unknown> = {
      "@odata.context": `${svc.servicePath}/$metadata#${setName}`,
    };
    if (count !== undefined) body["@odata.count"] = count;
    body.value = rows.map((r) => serialize(svc, r, setName, type, node, opts));
    return json(200, body, opts);
  },
  entity(svc, row, setName, type, node, status = 200, extra, opts) {
    checkSelect(svc, type, node);
    const body = {
      "@odata.context": `${svc.servicePath}/$metadata#${setName}/$entity`,
      ...serialize(svc, row, setName, type, node, opts),
    };
    return json(status, body, opts, extra);
  },
  nullEntity() {
    return { status: 204 };
  },
  // Non-entity result of an operation: a complex value is the body; a primitive or a
  // collection is in "value"
  operationValue(svc, op, returnType, value, opts) {
    const context = `${svc.servicePath}/$metadata#${returnType.type}`;
    const wire = toWire(value, returnType, opts);
    if (returnType.complexType && !returnType.isCollection)
      return json(
        200,
        { "@odata.context": context, ...(wire as object) },
        opts,
      );
    return json(200, { "@odata.context": context, value: wire }, opts);
  },
  property(svc, entityUri, prop, value, opts) {
    return json(
      200,
      {
        "@odata.context": `${svc.servicePath}/$metadata#${entityUri.slice(svc.servicePath.length + 1)}/${prop.name}`,
        value: toWire(value, prop, opts),
      },
      opts,
    );
  },
  error(status, message, code = "MOCK") {
    return json(status, { error: { code, message } });
  },
};

export default v4;
// For the tests of the wire format
export { toWire };
