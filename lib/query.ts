// Once we parse a request's query options, this is what they look like (regardless of
// which protocol version sent them):
//
//   { filter, orderby, top, skip, count, search, select, expand }
//
// `expand`: it's a tree, not a flat list, because expanded collections can have their own query options
// V4 lets a client write $expand=Items($select=Material;$top=2) directly whereas
// V2 does this by nesting $select paths like Items/Material. Either way, we end up with one node
// per expanded navigation, and each node looks just like the top-level options plus its own children:
//
//   node = { expand: { <navName>: node }, select?: Set<string>, filter?, orderby?, top?, skip?, count? }

import type { AnyNavigation, EntityType, Model, QueryNode } from "./model.ts";

// The error's code, which a client can branch on: by its status, unless a more specific one
// says what to do about it (see Errors in docs/odata-support.md)
const STATUS_CODES: Record<number, string> = {
  400: "BadRequest",
  404: "NotFound",
  405: "MethodNotAllowed",
  409: "Conflict",
  410: "Gone",
  412: "PreconditionFailed",
  413: "PayloadTooLarge",
  428: "PreconditionRequired",
  500: "InternalError",
  501: "NotImplemented",
};

function errorCode(status: number): string {
  return own(STATUS_CODES, String(status)) ?? `Http${status}`;
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = errorCode(status)) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// A resource path decoded but for what a segment or a key needs to keep apart: decodeURI
// leaves / , = ? # & encoded (%2F, ...), and %25 stays %25, so that SO%2F2025 in a key
// isn't read as two segments, nor 50%25 decoded twice. Each segment's name and each key's
// value is then decoded on its own (see resource-path.ts). A $ means the same either way, so
// %24metadata is $metadata, though decodeURI leaves it encoded too.
const decodePath = (text: string) =>
  decodeURI(text.replace(/%25/gi, "%2525")).replace(/%24/g, "$");

// A path as a URL has it: a service folder's name may hold a space, a Ü, a # or a %, as
// /odata/v4/My Srv. What is encoded already stays as it is.
const serviceUrlPath = (text: string) =>
  encodeURI(text)
    .replace(/%25([0-9a-f]{2})/gi, "%$1")
    .replace(/[#?]/g, encodeURIComponent);

// decodeURI and decodeURIComponent throw a URIError on a malformed escape (%E0%A4%A).
// That is the client's mistake, so it is a 400.
function decodeUrl(
  text: string,
  decode: (text: string) => string = decodePath,
): string {
  try {
    return decode(text);
  } catch {
    throw new HttpError(400, `Malformed URL: ${text}`);
  }
}

// The model's lookups are plain objects, so a name from a request such as constructor or
// toString would find what every object inherits. own() finds only the record's own entries:
// it's how a name from a request is looked up.
function own<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

// An $expand tree is keyed by names from the request, so it has no prototype: any name,
// __proto__ too, is an entry of its own
function newNode(): QueryNode {
  return {
    expand: Object.create(null) as QueryNode["expand"],
    select: undefined,
  };
}

// "Items/PurchaseOrder" -> ensures node.expand.Items.expand.PurchaseOrder exists; returns the leaf.
function addExpandPath(root: QueryNode, path: string): QueryNode {
  let node = root;
  for (const seg of path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean))
    node = node.expand[seg] ||= newNode();
  return node;
}

// "Material" -> root.select; "Items/Material" -> node(Items).select, and Items in root.select:
// each level has what was selected of it, V2's way of selecting through a navigation. A path's
// intermediate segments must be expanded to matter, but recording them is harmless if not.
function addSelectPath(root: QueryNode, path: string): void {
  const segs = path
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segs.length === 0) return;
  let node = root;
  for (const seg of segs.slice(0, -1)) {
    (node.select ||= new Set()).add(seg);
    node = node.expand[seg] ||= newNode();
  }
  (node.select ||= new Set()).add(segs[segs.length - 1]);
}

// $select names that are neither a property nor a navigation of `type` are a 400, as are
// $expand names that aren't a navigation. "*" and qualified names (V4 operations, Namespace.*)
// pass. The protocols check once per response rather than per row, so an empty result is
// checked too.
// svc: the service, of which only these two are used
interface Lookup {
  model: Model;
  navigation(type: EntityType, name: string): AnyNavigation | undefined;
}

function checkSelect(svc: Lookup, type: EntityType, node: QueryNode): void {
  for (const name of node.select || []) {
    if (name.includes("/")) {
      checkSelectPath(svc, type, name);
      continue;
    }
    if (name === "*" || name.includes(".")) continue;
    if (node.compute?.some((c) => c.alias === name)) continue;
    if (!own(type.properties, name) && !svc.navigation(type, name))
      throw new HttpError(
        400,
        `${name} is not a property or navigation of ${type.name}`,
      );
  }
  for (const [name, child] of Object.entries(node.expand)) {
    const nav = svc.navigation(type, name);
    if (!nav)
      throw new HttpError(
        400,
        `${name} is not a navigation property of ${type.name}`,
      );
    const target = svc.model.entityTypes[nav.targetType];
    if (target) checkSelect(svc, target, child);
  }
}

// A V4 $select path into a complex value: "Addr/City", "Place/Stops/Addr", each step a field
// of the one before, and every one but the last a complex property (or a collection of
// them). A path through a navigation is what $expand's $select is for.
function checkSelectPath(svc: Lookup, type: EntityType, path: string): void {
  const [first, ...rest] = path.split("/");
  if (svc.navigation(type, first))
    throw new HttpError(
      400,
      `$select can't go through ${first}: for a navigation, write $expand=${first}($select=${rest.join("/")})`,
    );
  let props = type.properties;
  let owner = type.name;
  for (const [i, seg] of path.split("/").entries()) {
    if (seg.includes("."))
      throw new HttpError(
        501,
        `$select=${path}: a type cast in a $select path is not supported`,
      );
    const prop = own(props, seg);
    if (!prop)
      throw new HttpError(
        400,
        i === 0
          ? `${seg} is not a property or navigation of ${owner}`
          : `${seg} is not a property of ${owner}`,
      );
    if (i === rest.length) return;
    if (!prop.complexType)
      throw new HttpError(
        400,
        `$select=${path}: ${seg} isn't a complex property, so a path can't go into it`,
      );
    props = prop.complexType.properties;
    owner = prop.complexType.name;
  }
}

// Splits on `sep` at parenthesis depth 0, ignoring separators inside quotes.
function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    cur = "",
    inStr = false;
  for (const c of text) {
    if (c === "'") inStr = !inStr;
    if (!inStr) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === sep && depth === 0) {
        parts.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim() !== "" || parts.length) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// A $format the server does not implement is rejected with 501 instead of silently
// ignored: JSON coming back for $format=xml looks like a working response and is wrong.
// query: the request's query string, parsed
// known: the protocol's system query options. Any other option starting with $ is a 400, as
// the spec asks: answering as if it weren't there would hide a typo ($TOP=1 answering every
// row). Custom options (sap-client, search) have no $ and are left alone.
function rejectUnsupported(
  query: Record<string, unknown>,
  known: ReadonlySet<string>,
): void {
  for (const name of Object.keys(query))
    if (name.startsWith("$") && !known.has(name))
      throw new HttpError(400, `Unknown system query option ${name}`);
  // Given twice the option is a list, which none of them means. A custom option is the
  // operation's or nobody's, but for the one that's read as a query option.
  for (const name of Object.keys(query))
    if (
      (name.startsWith("$") || name === "search") &&
      typeof query[name] !== "string"
    )
      throw new HttpError(400, `${name} can only be given once`);
  checkFormat(query);
}

// A $format the resource isn't given in is a 501: $metadata is XML, everything else JSON
function checkFormat(query: Record<string, unknown>, format = "JSON"): void {
  if (Array.isArray(query.$format))
    throw new HttpError(400, "$format is given more than once");
  const [short, media] =
    format === "JSON"
      ? ["json", "application/json"]
      : ["xml", "application/xml"];
  const text = String(query.$format).trim().toLowerCase();
  if (
    query.$format !== undefined &&
    text !== short &&
    text.split(";")[0].trim() !== media
  )
    throw new HttpError(
      501,
      `$format=${query.$format} is not supported (${format} only)`,
    );
}

// A name in CSDL, as a regular expression's source (for the u flag): any letter or _ first, then
// also digits and combining marks
const NAME = "[\\p{L}_][\\p{L}\\p{M}\\p{N}_]*";

function parseInt10(text: unknown, name: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(String(text)))
    throw new HttpError(400, `Invalid ${name}: ${text}`);
  return Number(text);
}

// $count's value, true or false in either case. A blank one isn't given.
function parseBoolean(text: string | undefined, name: string): boolean {
  if (!text) return false;
  if (!/^(?:true|false)$/i.test(text))
    throw new HttpError(400, `Invalid ${name}: ${text}`);
  return text.toLowerCase() === "true";
}

export {
  HttpError,
  NAME,
  parseBoolean,
  errorCode,
  decodeUrl,
  serviceUrlPath,
  own,
  newNode,
  addExpandPath,
  addSelectPath,
  checkSelect,
  splitTopLevel,
  parseInt10,
  checkFormat,
  rejectUnsupported,
};
