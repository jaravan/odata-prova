// Links a write sets or removes between existing entities: Nav@odata.bind in a V4 body, and
// V2's {"Nav": {"__metadata": {"uri": ...}}} in a create (see writes.ts), V4's $ref and V2's
// $links (see service.ts). Whatever a navigation joins on, linking is the same request:
//   - a foreign key on the entity's side (a normal or hidden one): its columns are set
//   - one on the target's side: the target's columns are set, and for a single-valued
//     navigation, the one it pointed at before is unlinked
//   - a link set (see links.ts): a pair is added or removed
// A contained or draft navigation can't be changed this way: its targets live under it.

import { HttpError, decodeUrl, own } from "./query.ts";
import { parseSegments, parseKey } from "./resource-path.ts";
import { renewETag } from "./etag.ts";
import { addLink, removeLink } from "./links.ts";
import type { LiteralSyntax } from "./filter.ts";
import type { ODataService } from "./service.ts";
import type {
  AnyNavigation,
  EntitySet,
  EntityType,
  Key,
  Model,
  Navigation,
  ODataResponse,
  Row,
} from "./model.ts";
import type { Store } from "./store.ts";

// What references use of the service (the ODataService in service.ts)
export interface ReferenceHost {
  model: Model;
  store: Store;
  servicePath: string;
  protocol: LiteralSyntax;
  entitySet(name: string): { set: EntitySet; type: EntityType };
  related(
    row: Row,
    type: EntityType,
    nav: AnyNavigation,
  ): { type: EntityType; rows: Row[] };
}

// A bad reference is the client's: a 400 its code names
function invalid(message: string): HttpError {
  return new HttpError(400, message, "InvalidReference");
}

// The entity a reference names: "Photos(2)", "/odata/v4/T/Photos(2)" or a full URL, of the
// navigation's target entity set
function resolveReference(
  svc: ReferenceHost,
  url: unknown,
  nav: Navigation,
): Row {
  if (typeof url !== "string" || !url)
    throw invalid(
      `A reference for ${nav.name} must be a URL, got ${JSON.stringify(url)}`,
    );
  let path = decodeUrl(url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ""));
  if (path.startsWith(`${svc.servicePath}/`))
    path = path.slice(svc.servicePath.length + 1);
  else if (path.startsWith("/"))
    throw invalid(`${url} is not an entity of this service`);
  const segments = parseSegments(path);
  const [segment] = segments;
  const es = segment && own(svc.model.entitySets, segment.name);
  if (segments.length !== 1 || !es || es.contained || !segment.keyText)
    throw invalid(`${url} is not an entity of an entity set, as Set(key)`);
  if (es.name !== nav.targetSet)
    throw invalid(`${nav.name} links to ${nav.targetSet}, not ${es.name}`);
  const type = svc.entitySet(es.name).type;
  const key = parseKey(segment.keyText, type, svc.protocol) as Key;
  const row = svc.store.find(es.name, type, key);
  if (!row) throw invalid(`${url}: no such ${type.name}`);
  return row;
}

// The navigation as a link can change it, or a 400
function changeable(type: EntityType, nav: AnyNavigation): Navigation {
  if ("contained" in nav && nav.contained)
    throw invalid(
      `${nav.name} contains its targets: create them through it instead`,
    );
  if (!("dependentSide" in nav))
    throw invalid(`${nav.name} is the draft's own: it can't be linked`);
  return nav;
}

// Clears columns that hold a link, which they must be able to: a key or a required property
// can't be null, so the link can only be replaced
function clear(type: EntityType, row: Row, columns: string[]): void {
  for (const c of columns) {
    const prop = own(type.properties, c);
    if (type.keys.includes(c) || (prop && !prop.nullable))
      throw invalid(
        `${type.name}.${c} is required: the link can be replaced, not removed`,
      );
  }
  for (const c of columns) row[c] = null;
}

// Links row (of setName, type) to target through nav: for a single-valued navigation instead
// of what it linked to, for a collection besides
function link(
  svc: ReferenceHost,
  setName: string,
  type: EntityType,
  row: Row,
  anyNav: AnyNavigation,
  target: Row,
): void {
  const nav = changeable(type, anyNav);
  if (nav.links) {
    addLink(svc.model, svc.store, nav, row, target);
    return;
  }
  const targetType = svc.entitySet(nav.targetSet).type;
  if (nav.dependentSide === "source") {
    // A foreign key in the entity's key (an item's order) is set when it's created, by
    // boundValues in writes.ts, and can't change after
    for (const [src, tgt] of nav.join)
      if (type.keys.includes(src) && String(row[src]) !== String(target[tgt]))
        throw invalid(
          `${nav.name} links through ${type.name}'s key, which can't change`,
        );
    for (const [src, tgt] of nav.join) row[src] = target[tgt];
    renewETag(svc.model, setName, type, row);
    return;
  }
  for (const [, tgt] of nav.join)
    if (targetType.keys.includes(tgt))
      throw invalid(
        `${nav.name} links through ${targetType.name}'s key, which can't change`,
      );
  if (!nav.isCollection)
    for (const other of svc.related(row, type, nav).rows)
      if (other !== target) unlinkTarget(svc, nav, targetType, other);
  for (const [src, tgt] of nav.join) target[tgt] = row[src];
  renewETag(svc.model, nav.targetSet, targetType, target);
}

function unlinkTarget(
  svc: ReferenceHost,
  nav: Navigation,
  targetType: EntityType,
  target: Row,
): void {
  clear(
    targetType,
    target,
    nav.join.map(([, tgt]) => tgt),
  );
  renewETag(svc.model, nav.targetSet, targetType, target);
}

// Removes row's link to target through nav, or, for a single-valued navigation without a
// target, whatever it links to
function unlink(
  svc: ReferenceHost,
  setName: string,
  type: EntityType,
  row: Row,
  anyNav: AnyNavigation,
  target?: Row,
): void {
  const nav = changeable(type, anyNav);
  const targets = target ? [target] : svc.related(row, type, nav).rows;
  if (nav.links) {
    for (const t of targets) removeLink(svc.model, svc.store, nav, row, t);
    return;
  }
  if (nav.dependentSide === "source") {
    clear(
      type,
      row,
      nav.join.map(([src]) => src),
    );
    renewETag(svc.model, setName, type, row);
    return;
  }
  const targetType = svc.entitySet(nav.targetSet).type;
  for (const t of targets) unlinkTarget(svc, nav, targetType, t);
}

// The links of parent.row's navigation (see references.ts): GET reads them, PUT sets a
// single-valued navigation's, POST adds one to a collection's, DELETE removes one. target:
// the entity the path names (Nav(key), or a single-valued navigation's), keyed: by a key.
// A link to set is the body's @odata.id (V4) or uri (V2); one to remove from a
// collection, V4's $id too.
function referenceRequest(
  svc: ODataService,
  method: string,
  parent: { row: Row; type: EntityType; nav: AnyNavigation; setName: string },
  target: Row | undefined,
  keyed: boolean,
  body: unknown,
  query: Record<string, unknown>,
): ODataResponse {
  const { row, type, nav, setName } = parent;
  if (!("dependentSide" in nav))
    throw new HttpError(400, `${nav.name} is the draft's own: it has no links`);
  const targetType = svc.entitySet(nav.targetSet).type;
  const url = (field: string) =>
    body && typeof body === "object"
      ? (body as Record<string, unknown>)[field]
      : undefined;
  const given = () =>
    resolveReference(
      svc,
      url(svc.protocol.version === "4.0" ? "@odata.id" : "uri"),
      nav,
    );
  switch (method) {
    case "GET": {
      const rows = target ? [target] : svc.related(row, type, nav).rows;
      return svc.protocol.references(
        svc,
        rows.map((r) => svc.entityUri(nav.targetSet, targetType, r)),
        !nav.isCollection || keyed,
      );
    }
    case "PUT":
      if (nav.isCollection)
        throw new HttpError(405, `POST a link to the collection ${nav.name}`);
      link(svc, setName, type, row, nav, given());
      return { status: 204 };
    case "POST":
      if (!nav.isCollection)
        throw new HttpError(405, `PUT the link of ${nav.name}`);
      link(svc, setName, type, row, nav, given());
      return { status: 204 };
    case "DELETE": {
      if (!nav.isCollection) {
        unlink(svc, setName, type, row, nav);
        return { status: 204 };
      }
      const which = keyed
        ? target
        : query.$id !== undefined
          ? resolveReference(svc, query.$id, nav)
          : undefined;
      if (!which)
        throw new HttpError(
          400,
          `Name the link to remove: ${nav.name}(key)/$ref, or $id`,
        );
      unlink(svc, setName, type, row, nav, which);
      return { status: 204 };
    }
    default:
      throw new HttpError(405, `${method} not allowed on links`);
  }
}

export { resolveReference, link, unlink, changeable, referenceRequest };
