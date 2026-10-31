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
import type { ODataService } from "../service.ts";
import type { Protocol } from "../protocol.ts";
import { toInternal, specialFloat } from "../types.ts";
import {
  HttpError,
  own,
  newNode,
  addExpandPath,
  addSelectPath,
  checkSelect,
  splitTopLevel,
  parseInt10,
  rejectUnsupported,
  errorCode,
} from "../query.ts";
import { parseApply } from "../apply-parse.ts";
import { parseCompute } from "../compute.ts";
import { expandLink } from "../paging.ts";

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
  // INF and NaN, which a property can't be named after a literal of: a whole word only
  if ((m = text.match(/^(INF|NaN)(?![\w./])/)))
    return {
      value: m[1] === "INF" ? Infinity : NaN,
      type: "Edm.Double",
      length: m[0].length,
    };
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

// Internal -> key literal in a URL. Only strings are quoted in V4, and percent-encoded, so
// that a / or a ? in one stays part of the key (see decodePath).
function keyLiteral(value: PropertyValue, prop: Property): string {
  return prop.type === "Edm.String"
    ? `'${encodeURIComponent(String(value).replace(/'/g, "''"))}'`
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
    (_: string, sec: string, frac: string = "") =>
      digits ? `${sec}.${frac.padEnd(digits, "0").slice(0, digits)}` : sec,
  );
}

// A number JSON.stringify writes as the given text, every digit kept (Node 21 and later; not
// in TypeScript's lib yet)
const rawJSON = (text: string): unknown =>
  (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(text);

// Internal -> V4 JSON value: arrays for collections, objects for complex types (converted
// field by field), member names for enums. Int64/Decimal go out as strings when the client
// asked for IEEE754Compatible=true (UI5's V4 model always does), as numbers otherwise: their
// stored digits, which a double would round (9007199254740993, 12345678901234567890.12).
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
    return /^-?\d+(\.\d+)?$/.test(String(value))
      ? rawJSON(String(value))
      : Number(value);
  if (type === "Edm.DateTimeOffset" || type === "Edm.TimeOfDay")
    return withPrecision(value, prop.precision);
  return value;
}

// "$expand=Items($select=Material;$top=2;$expand=PurchaseOrder),Other" -> node tree.
function parseExpand(text: string | undefined, node: QueryNode): void {
  for (const item of splitTopLevel(text || "", ",")) {
    const m = item.match(/^([^(]+?)\s*(?:\((.*)\))?$/s);
    if (!m) throw new HttpError(400, `Invalid $expand: ${item}`);
    // * expands every navigation (see expandAll). The spec's */$ref and *($levels=n) need
    // $ref and $levels in $expand, which aren't supported.
    if (
      m[1].trim().startsWith("*") &&
      (m[1].trim() !== "*" || m[2] !== undefined)
    )
      throw new HttpError(
        501,
        `$expand=${item.trim()} is not supported: only * on its own`,
      );
    const child = addExpandPath(node, m[1]);
    if (m[2] !== undefined) applyNestedOptions(child, m[2]);
  }
}

// $expand=*: every navigation of the type, as if each were named on its own, with no options.
// A navigation also named on its own keeps its options (*,Items($top=2)), and one the server
// can't serve (disabled, see navigations.ts) is left out, rather than fail the request. Done
// for each level's type, before the response is written, so nothing after sees the *.
function expandAll(
  svc: ODataService,
  type: EntityType,
  node: QueryNode,
): QueryNode {
  // No prototype, as newNode's: a name like __proto__ stays a name, which is then refused
  const expand = newNode().expand;
  for (const [name, child] of Object.entries(node.expand)) {
    if (name === "*") continue;
    const nav = svc.navigation(type, name);
    expand[name] = nav
      ? expandAll(svc, svc.model.entityTypes[nav.targetType], child)
      : child;
  }
  if ("*" in node.expand)
    for (const name of [
      ...Object.keys(type.navigations),
      ...Object.keys(type.draftNavigations ?? {}),
    ])
      if (!(name in expand) && !own(type.disabledNavigations, name))
        expand[name] = newNode();
  return { ...node, expand };
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
      case "$compute":
        node.compute = parseCompute(value);
        break;
      default:
        throw new HttpError(400, `Unsupported $expand option: ${name}`);
    }
  }
}

const SYSTEM_OPTIONS = new Set([
  "$filter",
  "$orderby",
  "$top",
  "$skip",
  "$skiptoken",
  "$count",
  "$search",
  "$select",
  "$expand",
  "$apply",
  "$compute",
  "$deltatoken",
  "$format",
  "$id",
]);

function parseQueryOptions(query: Record<string, unknown>): QueryNode {
  rejectUnsupported(query, SYSTEM_OPTIONS);
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
    skiptoken: parseInt10(q.$skiptoken, "$skiptoken"),
    count: q.$count === "true",
    search: q.$search,
    select: root.select,
    expand: root.expand,
    apply: q.$apply ? parseApply(q.$apply) : undefined,
    compute: q.$compute ? parseCompute(q.$compute) : undefined,
    deltatoken: q.$deltatoken,
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
  const etag = svc.etag(setName, row);
  if (etag) out["@odata.etag"] = etag;
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
    // Paged as the response is (see paging.ts), with a link to the rest
    const page = opts?.page && {
      size: opts.page.size,
      link: (skiptoken: number) =>
        expandLink(
          svc.entityUri(setName, type, row),
          navName,
          optionsOf(child),
          skiptoken,
        ),
    };
    const {
      rows,
      count,
      type: targetType,
      nextLink,
    } = svc.expandRows(row, type, nav, child, page);
    const nested = (r: Row) =>
      serialize(svc, r, nav.targetSet, targetType, child, opts);
    if (nav.isCollection) {
      if (child.count) out[`${navName}@odata.count`] = count;
      out[navName] = rows.map(nested);
      if (nextLink) out[`${navName}@odata.nextLink`] = nextLink;
    } else {
      out[navName] = rows[0] ? nested(rows[0]) : null;
    }
  }
  return out;
}

// An $expand node's options as a request writes them, for the link to the rest of an expanded
// collection: [["$filter", "..."], ["$expand", "Items($select=A;$top=2)"], ...]
function optionsOf(node: QueryNode): [string, string][] {
  const out: [string, string][] = [];
  if (node.filter) out.push(["$filter", node.filter]);
  if (node.search) out.push(["$search", node.search]);
  if (node.compute)
    out.push([
      "$compute",
      node.compute.map((c) => `${c.expression} as ${c.alias}`).join(","),
    ]);
  if (node.orderby) out.push(["$orderby", node.orderby]);
  if (node.skip !== undefined) out.push(["$skip", String(node.skip)]);
  if (node.top !== undefined) out.push(["$top", String(node.top)]);
  if (node.count) out.push(["$count", "true"]);
  if (node.select) out.push(["$select", [...node.select].join(",")]);
  const expand = Object.entries(node.expand).map(([name, child]) => {
    const inner = optionsOf(child).map(([k, v]) => `${k}=${v}`);
    return inner.length ? `${name}(${inner.join(";")})` : name;
  });
  if (expand.length) out.push(["$expand", expand.join(",")]);
  return out;
}

// What a context URL names setName's entities by: the set, or for a contained one, the path
// through its parent (OData 4.01 Part 1, 10.1 and 10.3): People('x')/Trips, as the set it's in
// is the server's own, in no $metadata. A collection's path comes with the request
// (opts.containedPath); an entity's, from its URL without its key: People('x')/Trips(1001).
function contextSet(
  svc: ODataService,
  setName: string,
  opts: ResponseOptions | undefined,
  entity?: { type: EntityType; row: Row },
): string {
  const contained = svc.model.entitySets[setName]?.contained;
  if (!contained) return setName;
  if (!entity) return opts?.containedPath ?? setName;
  const uri = svc
    .entityUri(setName, entity.type, entity.row)
    .slice(svc.servicePath.length + 1);
  const at = uri.lastIndexOf(`/${contained.navigation}(`);
  return at === -1
    ? setName
    : uri.slice(0, at + contained.navigation.length + 1);
}

// The select-list of a context URL, as $select and $expand shape the response (OData 4.0
// Part 1, 10.9): "(Name,Total,Category(Name))" for $select=Name,Total&$expand=Category(
// $select=Name), with $compute's aliases among the names when they're selected. An expanded
// navigation is listed, with its own list or "()", where the level has a $select; a level
// without one has every property, and no list.
function selectList(node: QueryNode): string {
  if (!node.select) return "";
  const names = [...node.select].filter((name) => !(name in node.expand));
  for (const [name, child] of Object.entries(node.expand))
    names.push(`${name}(${selectList(child).slice(1, -1)})`);
  return `(${names.join(",")})`;
}

// ["Supplier/Name", "Supplier/City", "Total"] -> "Supplier(Name,City),Total"
function contextList(paths: string[]): string {
  const nested = new Map<string, string[]>();
  for (const path of paths) {
    const [head, ...rest] = path.split("/");
    const tails = nested.get(head) ?? [];
    if (rest.length) tails.push(rest.join("/"));
    nested.set(head, tails);
  }
  return [...nested]
    .map(([head, tails]) =>
      tails.length ? `${head}(${contextList(tails)})` : head,
    )
    .join(",");
}

// Sets out.Supplier.Name for "Supplier/Name". A collection navigation on the way is a list
// of the one entity the row was copied for (see withPaths in aggregation.ts):
// "Items/Material" is {"Items":[{"Material":...}]}
function setPath(
  out: Record<string, unknown>,
  path: string,
  value: unknown,
  collectionSegments: number[] = [],
) {
  const parts = path.split("/");
  let at = out;
  for (const [i, part] of parts.slice(0, -1).entries())
    at = collectionSegments.includes(i)
      ? ((at[part] ??= [{}]) as Record<string, unknown>[])[0]
      : ((at[part] ??= {}) as Record<string, unknown>);
  at[parts[parts.length - 1]] = value;
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
      value: Object.values(svc.model.entitySets)
        .filter((es) => !es.contained && !es.unlisted)
        .map(({ name }) => ({
          name,
          kind: "EntitySet",
          url: name,
        })),
    });
  },
  collection(
    svc,
    { rows, count, nextLink, deltaLink },
    setName,
    type,
    node,
    opts,
  ) {
    node = expandAll(svc, type, node);
    checkSelect(svc, type, node);
    const body: Record<string, unknown> = {
      "@odata.context": `${svc.servicePath}/$metadata#${contextSet(svc, setName, opts)}${selectList(node)}`,
    };
    if (count !== undefined) body["@odata.count"] = count;
    body.value = rows.map((r) => serialize(svc, r, setName, type, node, opts));
    if (nextLink) body["@odata.nextLink"] = nextLink;
    if (deltaLink) body["@odata.deltaLink"] = deltaLink;
    return json(200, body, opts);
  },
  deltaOption(token) {
    return { $deltatoken: token };
  },
  // A delta response, in the OData 4.0 JSON format: the entities added or changed, then one
  // $deletedEntity entry for each that's gone, and the next delta link
  delta(svc, { rows, removed, deltaLink }, setName, type, node, opts) {
    node = expandAll(svc, type, node);
    checkSelect(svc, type, node);
    const context = `${svc.servicePath}/$metadata#${setName}`;
    return json(
      200,
      {
        "@odata.context": `${context}/$delta`,
        value: [
          ...rows.map((r) => serialize(svc, r, setName, type, node, opts)),
          ...removed.map(({ row, reason }) => ({
            "@odata.context": `${context}/$deletedEntity`,
            id: svc.entityUri(setName, type, row),
            reason,
          })),
        ],
        "@odata.deltaLink": deltaLink,
      },
      opts,
    );
  },
  // Rows of an $apply's result type: no key and so no ETag, and the context lists the
  // properties, e.g. $metadata#PurchaseOrderSet(Currency,Total). Each row has the ones it
  // holds: a concat's rows come from different sequences. A path a groupby grouped by is
  // nested, as the navigations it follows: "Supplier/Name" is {"Supplier":{"Name":...}},
  // and Supplier(Name) in the context. A row that is one of the entities is written as one,
  // with its ETag and node's $select and $expand (see the Protocol interface).
  aggregated(
    svc,
    { rows, count, nextLink },
    setName,
    type,
    node,
    entities,
    opts,
  ) {
    node = expandAll(svc, entities.type, node);
    const select = node.select;
    const names = Object.keys(type.properties);
    // A $select of a navigation (Supplier) picks the paths through it
    const selected = (name: string) =>
      !select || select.has("*") || select.has(name.split("/")[0]);
    for (const name of select || [])
      if (
        name !== "*" &&
        !names.some((n) => n.split("/")[0] === name) &&
        !svc.navigation(entities.type, name)
      )
        throw new HttpError(
          400,
          `${name} is not a property of the $apply result`,
        );
    const props = Object.values(type.properties).filter((p) =>
      selected(p.name),
    );
    const body: Record<string, unknown> = {
      "@odata.context": `${svc.servicePath}/$metadata#${contextSet(svc, setName, opts)}(${contextList(props.map((p) => p.name))})`,
    };
    if (count !== undefined) body["@odata.count"] = count;
    body.value = rows.map((r) => {
      if (entities.has(r))
        return serialize(svc, r, setName, entities.type, node, opts);
      const out: Record<string, unknown> = {};
      for (const p of props)
        if (p.name in r)
          setPath(
            out,
            p.name,
            toWire(r[p.name], p, opts),
            p.collectionSegments,
          );
      return out;
    });
    if (nextLink) body["@odata.nextLink"] = nextLink;
    return json(200, body, opts);
  },
  entity(svc, row, setName, type, node, status = 200, extra, opts) {
    node = expandAll(svc, type, node);
    checkSelect(svc, type, node);
    const body = {
      "@odata.context": `${svc.servicePath}/$metadata#${contextSet(svc, setName, opts, { type, row })}${selectList(node)}/$entity`,
      ...serialize(svc, row, setName, type, node, opts),
    };
    const etag = svc.etag(setName, row);
    return json(status, body, opts, etag ? { ...extra, ETag: etag } : extra);
  },
  nullEntity() {
    return { status: 204 };
  },
  references(svc, uris, single) {
    const context = `${svc.servicePath}/$metadata#`;
    if (single)
      return json(200, {
        "@odata.context": `${context}$ref`,
        "@odata.id": uris[0],
      });
    return json(200, {
      "@odata.context": `${context}Collection($ref)`,
      value: uris.map((uri) => ({ "@odata.id": uri })),
    });
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
  error(status, message, code = errorCode(status)) {
    return json(status, { error: { code, message } });
  },
};

export default v4;
// For the tests of the wire format
export { toWire };
