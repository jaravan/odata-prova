// v2 response characteristics: the {d: ...} envelope, __metadata/__deferred,
// /Date()/ timestamps, typed URL literals (datetime'...', guid'...', 12L), $inlinecount
// instead of $count, and $expand/$select written as slash-separated paths.
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
import { toInternal, toMillis, timeOfDayToV2, specialFloat } from "../types.ts";
import {
  HttpError,
  newNode,
  addExpandPath,
  addSelectPath,
  checkSelect,
  parseInt10,
  rejectUnsupported,
} from "../query.ts";

const version = "2.0";
const headers: Record<string, string> = { DataServiceVersion: "2.0" };
const typedLiteralPrefixes = new Set([
  "datetime",
  "datetimeoffset",
  "guid",
  "time",
  "binary",
  "x",
]);

// URL / $filter literal -> { value (internal), type }.
function parseLiteral(text: string): Literal {
  const t = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^'((?:[^']|'')*)'$/)))
    return { value: m[1].replace(/''/g, "'"), type: "Edm.String" };
  if ((m = t.match(/^guid'([^']+)'$/i)))
    return { value: m[1], type: "Edm.Guid" };
  if ((m = t.match(/^datetime'([^']+)'$/i)))
    return {
      value: toInternal(m[1], "Edm.DateTimeOffset"),
      type: "Edm.DateTimeOffset",
    };
  if ((m = t.match(/^datetimeoffset'([^']+)'$/i)))
    return {
      value: toInternal(m[1], "Edm.DateTimeOffset"),
      type: "Edm.DateTimeOffset",
    };
  if ((m = t.match(/^time'([^']+)'$/i)))
    return { value: toInternal(m[1], "Edm.TimeOfDay"), type: "Edm.TimeOfDay" };
  if ((m = t.match(/^(?:binary|X)'([^']*)'$/i)))
    return { value: m[1], type: "Edm.Binary" };
  if (t === "true" || t === "false")
    return { value: t === "true", type: "Edm.Boolean" };
  if (t === "null") return { value: null, type: null };
  if ((m = t.match(/^(-?\d+)[lL]$/))) return { value: m[1], type: "Edm.Int64" };
  if ((m = t.match(/^(-?\d+(?:\.\d+)?)[mM]$/)))
    return { value: m[1], type: "Edm.Decimal" };
  if ((m = t.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[dDfF]?$/)))
    return { value: Number(m[1]), type: "Edm.Double" };
  throw new HttpError(400, `Cannot parse literal: ${text}`);
}

// Internal -> key literal in a URL, e.g. 'abc', 42, guid'...', datetime'2025-01-01T00:00:00'.
// Internal date and time values are ISO strings.
function keyLiteral(value: PropertyValue, prop: Property): string {
  switch (prop.v2Type) {
    case "Edm.String":
      return `'${String(value).replace(/'/g, "''")}'`;
    case "Edm.Guid":
      return `guid'${value}'`;
    case "Edm.DateTime":
      return `datetime'${new Date(toMillis(value as string))
        .toISOString()
        .replace(/\.000Z$/, "")
        .replace(/Z$/, "")}'`;
    case "Edm.DateTimeOffset":
      return `datetimeoffset'${value}'`;
    case "Edm.Time":
      return `time'${timeOfDayToV2(value as string)}'`;
    case "Edm.Int64":
      return `${value}L`;
    case "Edm.Decimal":
      return `${value}M`;
    default:
      return String(value);
  }
}

// Internal -> V2 JSON value. A complex value carries its type in __metadata, as SAP
// Gateway sends it; collection-valued properties do not exist in V2 (v2Omit).
// Returns a JSON value.
function toWire(value: PropertyValue | undefined, prop: Property): unknown {
  if (value === null || value === undefined) return null;
  if (specialFloat(value)) return specialFloat(value);
  if (prop.complexType) {
    const fields = value as Record<string, PropertyValue>;
    const out: Record<string, unknown> = {
      __metadata: { type: prop.complexType.fullName },
    };
    for (const p of Object.values(prop.complexType.properties))
      if (!p.v2Omit) out[p.name] = toWire(fields[p.name], p);
    return out;
  }
  // Internal date and time values are ISO strings
  switch (prop.v2Type) {
    case "Edm.DateTime":
      return `/Date(${toMillis(value as string)})/`;
    case "Edm.DateTimeOffset":
      return `/Date(${toMillis(value as string)}+0000)/`;
    case "Edm.Time":
      return timeOfDayToV2(value as string);
    default:
      return value;
  }
}

function parseQueryOptions(query: Record<string, unknown>): QueryNode {
  rejectUnsupported(query);
  // Query string values are text (a repeated option isn't supported)
  const q = query as Record<string, string | undefined>;
  const root = newNode();
  for (const path of (q.$expand || "").split(",")) addExpandPath(root, path);
  if (q.$select)
    for (const path of q.$select.split(",")) addSelectPath(root, path);
  return {
    filter: q.$filter,
    orderby: q.$orderby,
    top: parseInt10(q.$top, "$top"),
    skip: parseInt10(q.$skip, "$skip"),
    count: q.$inlinecount === "allpages",
    search: undefined,
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
): Record<string, unknown> {
  const uri = svc.entityUri(setName, type, row);
  const out: Record<string, unknown> = {
    __metadata: { id: uri, uri, type: type.fullName },
  };
  const selectAll = !node.select || node.select.has("*");

  for (const p of Object.values(type.properties)) {
    if (!p.v2Omit && (selectAll || node.select?.has(p.name)))
      out[p.name] = toWire(row[p.name], p);
  }
  // Unknown $expand names are ignored as before; a disabled navigation is a 501
  for (const name of Object.keys(node.expand)) svc.navigation(type, name);
  const navs = { ...type.navigations, ...type.draftNavigations };
  for (const nav of Object.values(navs)) {
    const expanded = nav.name in node.expand;
    if (!selectAll && !node.select?.has(nav.name) && !expanded) continue;
    if (expanded) {
      const child = node.expand[nav.name];
      const { rows, type: targetType } = svc.expandRows(row, type, nav, child);
      const nested = (r: Row) =>
        serialize(svc, r, nav.targetSet, targetType, child);
      out[nav.name] = nav.isCollection
        ? { results: rows.map(nested) }
        : rows[0]
          ? nested(rows[0])
          : null;
    } else {
      out[nav.name] = { __deferred: { uri: `${uri}/${nav.name}` } };
    }
  }
  return out;
}

function json(
  status: number,
  body: unknown,
  extra?: Record<string, string>,
): ODataResponse {
  return {
    status,
    body,
    contentType: "application/json;charset=utf-8",
    headers: extra,
  };
}

const v2: Protocol = {
  version,
  headers,
  typedLiteralPrefixes,
  parseLiteral,
  keyLiteral,
  parseQueryOptions,
  serviceDocument(svc) {
    return json(200, { d: { EntitySets: Object.keys(svc.model.entitySets) } });
  },
  collection(svc, { rows, count }, setName, type, node) {
    checkSelect(svc, type, node);
    const d: Record<string, unknown> = {
      results: rows.map((r) => serialize(svc, r, setName, type, node)),
    };
    if (count !== undefined) d.__count = String(count);
    return json(200, { d });
  },
  entity(svc, row, setName, type, node, status = 200, extra) {
    checkSelect(svc, type, node);
    return json(status, { d: serialize(svc, row, setName, type, node) }, extra);
  },
  nullEntity() {
    return json(200, { d: null });
  },
  // Non-entity result of a function import, as SAP Gateway sends it:
  // { d: { <FunctionName>: value } }, or { d: { results: [...] } } for a collection
  operationValue(svc, op, returnType, value) {
    const element: Property = {
      ...returnType,
      isCollection: false,
      v2Type: returnType.v2Type.replace(/^Collection\((.+)\)$/, "$1"),
    };
    if (returnType.isCollection)
      return json(200, {
        d: {
          results: (value as PropertyValue[]).map((v) => toWire(v, element)),
        },
      });
    return json(200, { d: { [op.name]: toWire(value, element) } });
  },
  property(svc, entityUri, prop, value) {
    if (prop.v2Omit)
      throw new HttpError(
        404,
        `${prop.name} is a collection-valued property, not available in OData V2`,
      );
    return json(200, { d: { [prop.name]: toWire(value, prop) } });
  },
  error(status, message, code = "MOCK") {
    return json(status, {
      error: { code, message: { lang: "en", value: message } },
    });
  },
};

export default v2;
