// The generic OData request handler, one instance per (protocol, service path), all
// sharing one store. Everything here is driven by the parsed model; the protocol object
// decides how literals are read and how responses are written.
//
// dispatch(method, path, query, body, headers) -> { status, body?, contentType?, headers? }
// is the single entry point, used both by the Express routes and by $batch parts. It walks
// the resource path (resource-path.ts) and hands the work to the modules for each part:
// query options (apply-query.ts), writes (writes.ts), operations (operations.ts) and
// drafts (draft.ts).
import { specialFloat } from "./types.ts";
import type { LiteralSyntax } from "./filter.ts";
import { HttpError, own } from "./query.ts";
import { draftMatch, Drafts } from "./draft.ts";
import { etagOf, checkIfMatch, renewETag } from "./etag.ts";
import type { ETagMode } from "./etag.ts";
import { parseSegments, parseKey } from "./resource-path.ts";
import { applyQuery } from "./apply-query.ts";
import { applyCompute } from "./compute.ts";
import { DeltaTokens, deltaChanges, type Removed } from "./delta.ts";
import { addLink, linkedRows } from "./links.ts";
import { link, resolveReference, unlink } from "./references.ts";
import { applyTransformations, holdsEntities } from "./aggregation.ts";
import { isHierarchyRow } from "./hierarchy.ts";
import { create, update, deleteEntity } from "./writes.ts";
import {
  operationImport,
  boundOperation,
  callOperation,
} from "./operations.ts";
import type {
  AnyNavigation,
  EntitySet,
  EntityType,
  Key,
  Model,
  ODataResponse,
  ODataVersion,
  Operation,
  OperationView,
  Property,
  PropertyValue,
  QueryNode,
  ResponseOptions,
  Row,
  TypedElement,
} from "./model.ts";
import type { Store } from "./store.ts";

// A collection's rows after its query options, the count $count asks for, and the next
// page's URL when server-driven paging leaves rows out
export interface CollectionResult {
  rows: Row[];
  count?: number;
  nextLink?: string;
  // The delta link of a client that tracks changes, with the last page (see delta.ts)
  deltaLink?: string;
}

// What a protocol module supplies (protocols/v2 and v4): how literals are read and keys
// written, and what each kind of response looks like
export interface Protocol extends LiteralSyntax {
  version: ODataVersion;
  // Sent with every response (DataServiceVersion, OData-Version)
  headers: Record<string, string>;
  keyLiteral(value: PropertyValue, prop: Property): string;
  parseQueryOptions(query: Record<string, unknown>): QueryNode;
  serviceDocument(svc: ODataService): ODataResponse;
  // result.nextLink: the next page's URL, when server-driven paging leaves rows out
  collection(
    svc: ODataService,
    result: CollectionResult,
    setName: string,
    type: EntityType,
    node: QueryNode,
    opts?: ResponseOptions,
  ): ODataResponse;
  entity(
    svc: ODataService,
    row: Row,
    setName: string,
    type: EntityType,
    node: QueryNode,
    status?: number,
    extra?: Record<string, string>,
    opts?: ResponseOptions,
  ): ODataResponse;
  // The rows of an $apply's result type (see aggregation.ts); V4 only, V2 has no $apply.
  // entities: the entity type of the collection $apply ran on, and whether a result row is
  // one of its entities, which is written as one, with node's $select and $expand
  aggregated?(
    svc: ODataService,
    result: CollectionResult,
    setName: string,
    type: EntityType,
    node: QueryNode,
    entities: { type: EntityType; has(row: Row): boolean },
    opts?: ResponseOptions,
  ): ODataResponse;
  // A single-valued navigation or operation result that is empty
  nullEntity(): ODataResponse;
  // The links a navigation has, as $ref (V4) or $links (V2) reads them: the URLs of the
  // entities, one (single) or a list
  references(svc: ODataService, uris: string[], single: boolean): ODataResponse;
  // A non-entity operation result
  operationValue(
    svc: ODataService,
    op: Operation,
    returnType: TypedElement,
    value: PropertyValue,
    opts?: ResponseOptions,
  ): ODataResponse;
  property(
    svc: ODataService,
    uri: string,
    prop: Property,
    value: PropertyValue,
    opts?: ResponseOptions,
  ): ODataResponse;
  // code: what a client can branch on, by default the status's (see errorCode in query.ts)
  error(status: number, message: string, code?: string): ODataResponse;
  // What changed in an entity set since a delta token (see delta.ts); V4 only
  delta?(
    svc: ODataService,
    result: { rows: Row[]; removed: Removed[]; deltaLink: string },
    setName: string,
    type: EntityType,
    node: QueryNode,
    opts?: ResponseOptions,
  ): ODataResponse;
}

// What operations change, by operation name (config.json, see operationRules in app.ts):
// { ApprovePurchaseOrder: { set: { Status: "Approved" } } }
export type Rules = Record<string, { set?: Record<string, unknown> }>;

export interface ServiceOptions {
  model: Model;
  store: Store;
  protocol: Protocol;
  // Where the service is mounted: /odata/v4/MySrv
  servicePath: string;
  metadataXml: string;
  log?: (message: string) => void;
  rules?: Rules;
  // How strictly If-Match is checked (see etag.ts); default lenient
  etags?: ETagMode;
  // The most rows a collection's response holds (see paging); 0, the default: every row
  pageSize?: number;
}

// The request headers dispatch reads (accept, prefer)
export type RequestHeaders = Record<string, string | string[] | undefined>;

// Server-driven paging: a response holds at most a page of the rows the query options
// leave, and links to the next page with a $skiptoken, the offset where it starts among
// those rows. The token is the client's to send back as it is, in the link; $skip and $top
// stay as they were, so the pages add up to what the query asks for. A $skiptoken also
// works without paging: the rows from that offset on.
function paging(
  rows: Row[],
  q: QueryNode,
  opts: ResponseOptions,
): { rows: Row[]; nextLink?: string } {
  const start = q.skiptoken ?? 0;
  if (!opts.page) return { rows: rows.slice(start) };
  const end = start + opts.page.size;
  return {
    rows: rows.slice(start, end),
    nextLink: end < rows.length ? opts.page.link(end) : undefined,
  };
}

// The request's URL with some of its query options changed (undefined: left out): its path
// from the root, and its query options as they came, which are kept readable ($, commas,
// slashes and colons unescaped)
function requestLink(
  path: string,
  query: Record<string, unknown>,
  changes: Record<string, unknown>,
): string {
  const options = Object.entries({ ...query, ...changes })
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `${name}=${encodeURIComponent(String(value)).replace(/%(24|2C|2F|3A)/g, (e) => decodeURIComponent(e))}`,
    );
  return `${encodeURI(path)}?${options.join("&")}`;
}

class ODataService {
  model: Model;
  store: Store;
  protocol: Protocol;
  servicePath: string;
  metadataXml: string;
  log: (message: string) => void;
  rules: Rules;
  etags: ETagMode;
  pageSize: number;
  deltaTokens = new DeltaTokens();
  operations: OperationView;
  drafts: Drafts;

  constructor({
    model,
    store,
    protocol,
    servicePath,
    metadataXml,
    log = () => {},
    rules = {},
    etags = "lenient",
    pageSize = 0,
  }: ServiceOptions) {
    this.model = model;
    this.store = store;
    this.protocol = protocol;
    this.servicePath = servicePath;
    this.metadataXml = metadataXml;
    this.log = log;
    this.rules = rules;
    this.etags = etags;
    this.pageSize = pageSize;
    // The operations as this protocol serves them (see operationViews in metadata.ts)
    this.operations = model.operationViews[protocol.version];
    this.drafts = new Drafts(this);
  }

  entitySet(name: string): { set: EntitySet; type: EntityType } {
    const es = own(this.model.entitySets, name);
    if (!es) throw new HttpError(404, `Entity set ${name} not found`);
    return { set: es, type: this.model.entityTypes[es.entityType] };
  }

  // A contained entity's key is unique only under its parent (two people's trip 1001), so
  // its parent's keys, which it keeps, are part of what tells it apart (see
  // resolveContainment in navigations.ts), when row has them
  keyOf(entityType: EntityType, row: Row): Key {
    const parents = (entityType.parentKeys ?? []).filter(
      (k) => row[k] !== undefined,
    );
    return Object.fromEntries(
      [...parents, ...entityType.keys].map((k) => [k, row[k]]),
    );
  }

  // The entity's ETag, for an entity set that has them (see etag.ts)
  etag(setName: string, row: Row): string | undefined {
    return etagOf(this.model, setName, row);
  }

  // A contained entity's is its parent's, then the navigation: People('x')/Trips(1001)
  entityUri(setName: string, entityType: EntityType, row: Row): string {
    const lit = (k: string) =>
      this.protocol.keyLiteral(row[k], entityType.properties[k]);
    const keyText =
      entityType.keys.length === 1
        ? lit(entityType.keys[0])
        : entityType.keys.map((k) => `${k}=${lit(k)}`).join(",");
    const contained = this.model.entitySets[setName]?.contained;
    if (contained) {
      const parent = this.entitySet(contained.parentSet);
      const nav = parent.type.navigations[contained.navigation];
      const parentRow = this.store
        .rows(contained.parentSet)
        .find((p) =>
          nav.join.every(([src, tgt]) => String(p[src]) === String(row[tgt])),
        );
      if (parentRow)
        return `${this.entityUri(contained.parentSet, parent.type, parentRow)}/${contained.navigation}(${keyText})`;
    }
    return `${this.servicePath}/${setName}(${keyText})`;
  }

  // --- Navigation ------------------------------------------------------------------------

  // The draft entity set of a draft entity type (draft.ts keeps one per type)
  setOf(entityType: EntityType): string | undefined {
    return Object.values(this.model.entitySets).find(
      (es) => es.draft && es.entityType === entityType.fullName,
    )?.name;
  }

  related(
    row: Row,
    entityType: EntityType,
    nav: AnyNavigation,
  ): { type: EntityType; rows: Row[] } {
    if (nav.draft === "admin")
      return this.drafts.adminRows(
        this.setOf(entityType)!, // a type with draft navigations has a draft set
        entityType,
        nav,
        row,
      );
    const target = this.entitySet(nav.targetSet);
    if ("links" in nav && nav.links)
      return { ...target, rows: linkedRows(this.model, this.store, nav, row) };
    const rows = this.store
      .rows(nav.targetSet)
      .filter(
        (t) =>
          nav.join.every(([src, tgt]) => String(row[src]) === String(t[tgt])) &&
          draftMatch(nav, row, t),
      );
    return { ...target, rows };
  }

  // Related rows for an $expand node, with the node's own $filter/$orderby/$top/$skip applied.
  expandRows(
    row: Row,
    entityType: EntityType,
    nav: AnyNavigation,
    node: QueryNode,
  ): { rows: Row[]; count?: number; type: EntityType } {
    const { rows, type } = this.computed(
      this.related(row, entityType, nav),
      node,
    );
    const { results, count } = applyQuery(this, rows, type, {
      ...node,
      count: node.count,
    });
    return { rows: results, count, type };
  }

  // The navigation called `name` (SiblingEntity and DraftAdministrativeData included, see
  // draft.ts), or undefined. One the metadata declares but the server had to switch off (see
  // disableOnError in metadata.ts) is a 501, with the reason.
  navigation(type: EntityType, name: string): AnyNavigation | undefined {
    const reason = own(type.disabledNavigations, name);
    if (reason)
      throw new HttpError(
        501,
        `Navigation ${name} is not supported: ${reason}`,
      );
    const nav = own(type.navigations, name);
    if (nav?.contained && this.protocol.version === "2.0")
      throw new HttpError(
        404,
        `${name} is a containment navigation, not available in OData V2`,
      );
    return nav || own(type.draftNavigations, name);
  }

  // --- Collections -----------------------------------------------------------------------

  // The rows and type $apply gives (see aggregation.ts), or the rows as they are without one.
  // entities: whether a result row is still one of the entities, which can be expanded: one of
  // the rows it ran on, or a hierarchy function's copy of one (see hierarchy.ts)
  applied(
    rows: Row[],
    type: EntityType,
    q: QueryNode,
  ): {
    rows: Row[];
    type: EntityType;
    entities: { type: EntityType; has(row: Row): boolean };
  } {
    const input = new Set(rows);
    const entities = {
      type,
      has: (row: Row) => input.has(row) || isHierarchyRow(row),
    };
    if (!q.apply) return { rows, type, entities };
    for (const name of Object.keys(q.expand)) {
      if (!holdsEntities(q.apply))
        throw new HttpError(
          400,
          "$expand needs entities in the $apply result, which an aggregate or groupby replaces",
        );
      if (!this.navigation(type, name))
        throw new HttpError(
          400,
          `${name} is not a navigation property of ${type.name}`,
        );
    }
    return { ...applyTransformations(this, rows, type, q.apply), entities };
  }

  // The rows and type with $compute's properties (see compute.ts), or as they are without
  // one. $apply has a compute of its own, which isn't supported, so the two don't mix.
  computed(
    { rows, type }: { rows: Row[]; type: EntityType },
    q: QueryNode,
  ): { rows: Row[]; type: EntityType } {
    if (!q.compute) return { rows, type };
    if (q.apply)
      throw new HttpError(501, "$compute with $apply is not supported");
    return applyCompute(this, rows, type, q.compute);
  }

  // A collection's response: an entity set's, a navigation's or an operation's, after its
  // query options, $apply first
  collectionResponse(
    rows: Row[],
    setName: string,
    type: EntityType,
    q: QueryNode,
    opts: ResponseOptions,
  ): ODataResponse {
    ({ rows, type } = this.computed({ rows, type }, q));
    const applied = this.applied(rows, type, q);
    const { results, count } = applyQuery(this, applied.rows, applied.type, q);
    const result: CollectionResult = { ...paging(results, q, opts), count };
    if (opts.deltaLink && !result.nextLink) result.deltaLink = opts.deltaLink();
    if (q.apply)
      return this.protocol.aggregated!(
        this,
        result,
        setName,
        applied.type,
        q,
        applied.entities,
        opts,
      );
    return this.protocol.collection(this, result, setName, type, q, opts);
  }

  // The page size of a GET (see paging): the server's, or the smaller one a V4 client asks
  // for with Prefer: odata.maxpagesize=N. applied: the client's is the one used, which the
  // response confirms in Preference-Applied.
  pageSizeFor(prefer: string): { size: number; applied: boolean } {
    const asked =
      this.protocol.version === "4.0"
        ? Number(/odata\.maxpagesize=(\d+)/i.exec(prefer)?.[1] || 0)
        : 0;
    if (asked && (!this.pageSize || asked < this.pageSize))
      return { size: asked, applied: true };
    return { size: this.pageSize, applied: false };
  }

  // Whether a GET of an entity set gets a delta link: a V4 client asks for one with Prefer:
  // odata.track-changes, and the query is one a delta can answer, without $apply, $compute,
  // $skip or $top. Otherwise the preference isn't applied, as the spec allows.
  tracksChanges(prefer: string, q: QueryNode): boolean {
    return (
      !!this.protocol.delta &&
      /odata\.track-changes/i.test(prefer) &&
      !q.apply &&
      !q.compute &&
      q.skip === undefined &&
      q.top === undefined
    );
  }

  // What changed in the entity set since the delta token (see delta.ts), with a new delta
  // link. A token that's unknown, no longer kept or from before a restart is a 410 Gone. Only
  // V4 parses a $deltatoken, and has delta().
  deltaResponse(
    setName: string,
    type: EntityType,
    q: QueryNode,
    opts: ResponseOptions,
    link: (token: string) => string,
  ): ODataResponse {
    const before = this.deltaTokens.rows(q.deltatoken!, setName);
    if (!before)
      throw new HttpError(
        410,
        "The delta link has expired: read the entity set again for a new one",
        "DeltaLinkExpired",
      );
    const now = this.store.rows(setName);
    const changes = deltaChanges(this, type, before, now, q);
    const deltaLink = link(this.deltaTokens.issue(setName, now));
    return this.protocol.delta!(
      this,
      { ...changes, deltaLink },
      setName,
      type,
      q,
      opts,
    );
  }

  // --- References ------------------------------------------------------------------------

  // The links of parent.row's navigation (see references.ts): GET reads them, PUT sets a
  // single-valued navigation's, POST adds one to a collection's, DELETE removes one. target:
  // the entity the path names (Nav(key), or a single-valued navigation's), keyed: by a key.
  // A link to set is the body's @odata.id (V4) or uri (V2); one to remove from a
  // collection, V4's $id too.
  referenceRequest(
    method: string,
    parent: { row: Row; type: EntityType; nav: AnyNavigation; setName: string },
    target: Row | undefined,
    keyed: boolean,
    body: unknown,
    query: Record<string, unknown>,
  ): ODataResponse {
    const { row, type, nav, setName } = parent;
    if (!("dependentSide" in nav))
      throw new HttpError(
        400,
        `${nav.name} is the draft's own: it has no links`,
      );
    const targetType = this.entitySet(nav.targetSet).type;
    const url = (field: string) =>
      body && typeof body === "object"
        ? (body as Record<string, unknown>)[field]
        : undefined;
    const given = () =>
      resolveReference(
        this,
        url(this.protocol.version === "4.0" ? "@odata.id" : "uri"),
        nav,
      );
    switch (method) {
      case "GET": {
        const rows = target ? [target] : this.related(row, type, nav).rows;
        return this.protocol.references(
          this,
          rows.map((r) => this.entityUri(nav.targetSet, targetType, r)),
          !nav.isCollection || keyed,
        );
      }
      case "PUT":
        if (nav.isCollection)
          throw new HttpError(405, `POST a link to the collection ${nav.name}`);
        link(this, setName, type, row, nav, given());
        return { status: 204 };
      case "POST":
        if (!nav.isCollection)
          throw new HttpError(405, `PUT the link of ${nav.name}`);
        link(this, setName, type, row, nav, given());
        return { status: 204 };
      case "DELETE": {
        if (!nav.isCollection) {
          unlink(this, setName, type, row, nav);
          return { status: 204 };
        }
        const which = keyed
          ? target
          : query.$id !== undefined
            ? resolveReference(this, query.$id, nav)
            : undefined;
        if (!which)
          throw new HttpError(
            400,
            `Name the link to remove: ${nav.name}(key)/$ref, or $id`,
          );
        unlink(this, setName, type, row, nav, which);
        return { status: 204 };
      }
      default:
        throw new HttpError(405, `${method} not allowed on links`);
    }
  }

  // --- Dispatch --------------------------------------------------------------------------

  dispatch(
    method: string,
    path: string,
    query: Record<string, unknown> = {},
    body?: unknown,
    headers: RequestHeaders = {},
  ): ODataResponse {
    try {
      return this.handle(method, path, query, body, headers);
    } catch (e) {
      if (e instanceof HttpError)
        return this.protocol.error(e.status, e.message, e.code);
      console.error(e);
      return this.protocol.error(500, (e as Error).message);
    }
  }

  handle(
    method: string,
    path: string,
    query: Record<string, unknown>,
    body: unknown,
    headers: RequestHeaders,
  ): ODataResponse {
    if (!path.startsWith(this.servicePath))
      throw new HttpError(404, `Not found: ${path}`);
    const resourcePath = path
      .slice(this.servicePath.length)
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    const protocol = this.protocol;
    const opts: ResponseOptions = {
      ieee754: /IEEE754Compatible=true/i.test(String(headers.accept || "")),
      prefer: String(headers.prefer || ""),
    };
    const pageSize = this.pageSizeFor(opts.prefer);
    if (method === "GET" && pageSize.size)
      opts.page = {
        size: pageSize.size,
        link: (skiptoken) =>
          requestLink(path, query, { $skiptoken: skiptoken }),
      };
    const wantsMinimal = /return=minimal/i.test(opts.prefer);
    const wantsRepresentation = /return=representation/i.test(opts.prefer);

    if (resourcePath === "") {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return protocol.serviceDocument(this);
    }
    if (resourcePath === "$metadata") {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return {
        status: 200,
        contentType: "application/xml",
        body: this.metadataXml,
      };
    }

    const q = protocol.parseQueryOptions(query);
    const segments = parseSegments(resourcePath);
    let wantCount = false,
      wantValue = false;
    if (segments[segments.length - 1]?.name === "$count") {
      wantCount = true;
      segments.pop();
    }
    if (segments[segments.length - 1]?.name === "$value") {
      wantValue = true;
      segments.pop();
    }
    // The links of a navigation rather than its entities: V4's Nav/$ref, V2's $links/Nav
    let wantRefs = false;
    if (protocol.version === "4.0" && segments.at(-1)?.name === "$ref") {
      wantRefs = true;
      segments.pop();
    }
    const linksAt = segments.findIndex((s) => s.name === "$links");
    if (protocol.version === "2.0" && linksAt !== -1) {
      if (linksAt === 0 || linksAt !== segments.length - 2)
        throw new HttpError(
          400,
          "$links goes between an entity and a navigation",
        );
      wantRefs = true;
      segments.splice(linksAt, 1);
    }

    // Operation imports: /Name, /Name(a=1) (V4 functions), /Name?a=1 (V2)
    const first = segments[0].name;
    const imported =
      !own(this.model.entitySets, first) && operationImport(this, first);
    if (imported) {
      if (segments.length > 1 || wantCount || wantValue)
        throw new HttpError(
          501,
          `Path segments after ${first} are not supported`,
        );
      return callOperation(
        this,
        method,
        imported,
        undefined,
        segments[0].keyText,
        body,
        query,
        q,
        opts,
        headers,
      );
    }
    // A contained set is reached only through its navigation (see resolveContainment)
    if (
      !own(this.model.entitySets, first) ||
      this.model.entitySets[first].contained
    )
      throw new HttpError(404, `${first} is not an entity set or operation`);

    // Walk: entity set, then navigation properties, keeping the current row/collection.
    const start = this.entitySet(first);
    let type = start.type;
    let setName = start.set.name;
    let rows = this.store.rows(setName);
    let row: Row | undefined = undefined; // defined when the current position is a single entity
    const key = parseKey(segments[0].keyText, type, this.protocol);
    // When POSTing to Parent(key)/Nav
    let parentForCreate:
      | { row: Row; type: EntityType; nav: AnyNavigation; setName: string }
      | undefined = undefined;
    if (key) {
      row = this.store.find(setName, type, key);
      if (!row) throw new HttpError(404, `${type.name} not found`);
    }

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      // Bound operations: Set(key)/NS.Name or Set/NS.Name, with (a=1) for V4 functions
      const op =
        !this.navigation(type, seg.name) &&
        !own(type.properties, seg.name) &&
        boundOperation(this, seg.name, type, row === undefined);
      if (op) {
        if (i !== segments.length - 1 || wantCount || wantValue)
          throw new HttpError(
            501,
            `Path segments after ${seg.name} are not supported`,
          );
        return callOperation(
          this,
          method,
          op,
          { setName, type, row, rows },
          seg.keyText,
          body,
          query,
          q,
          opts,
          headers,
        );
      }
      if (row === undefined)
        throw new HttpError(400, `Cannot navigate ${seg.name} on a collection`);
      const nav = this.navigation(type, seg.name);
      if (!nav) {
        // Plain property access: Set(key)/Prop or Set(key)/Prop/$value
        const prop = own(type.properties, seg.name);
        if (!prop || i !== segments.length - 1)
          throw new HttpError(
            404,
            `${seg.name} is not a property or navigation of ${type.name}`,
          );
        if (wantRefs)
          throw new HttpError(
            400,
            `${seg.name} is a property, not a navigation`,
          );
        if (method !== "GET") throw new HttpError(405, "Method not allowed");
        if (q.apply)
          throw new HttpError(
            400,
            "$apply applies to reading a collection only",
          );
        const value = row[prop.name];
        if (wantValue)
          return {
            status: 200,
            contentType: "text/plain",
            body: value === null ? "" : specialFloat(value) || String(value),
          };
        return protocol.property(
          this,
          this.entityUri(setName, type, row),
          prop,
          value,
          opts,
        );
      }
      if (nav.draft === "admin" && method !== "GET")
        throw new HttpError(405, `${nav.name} is read-only`);
      const related = this.related(row, type, nav);
      parentForCreate = { row, type, nav, setName };
      setName = nav.targetSet;
      type = related.type;
      rows = related.rows;
      row = undefined;
      const segKey = parseKey(seg.keyText, type, this.protocol);
      if (segKey) {
        const segType = type;
        row = rows.find((r) => this.store.matchesKey(segType, r, segKey));
        if (!row) throw new HttpError(404, `${type.name} not found`);
      } else if (!nav.isCollection) {
        row = rows[0];
        if (!row && method === "GET") return protocol.nullEntity();
      }
    }

    if (wantRefs) {
      if (!parentForCreate || segments.length < 2)
        throw new HttpError(400, "Links are a navigation's: Set(key)/Nav/$ref");
      return this.referenceRequest(
        method,
        parentForCreate,
        row,
        !!segments.at(-1)!.keyText,
        body,
        query,
      );
    }

    if (q.deltatoken !== undefined) {
      if (method !== "GET" || row !== undefined || segments.length !== 1)
        throw new HttpError(
          400,
          "$deltatoken applies to reading an entity set",
        );
      return this.deltaResponse(setName, type, q, opts, (token) =>
        requestLink(path, query, {
          $skiptoken: undefined,
          $deltatoken: token,
        }),
      );
    }

    if (q.apply && (method !== "GET" || row !== undefined))
      throw new HttpError(400, "$apply applies to reading a collection only");

    if (wantCount) {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      ({ rows, type } = this.computed({ rows, type }, q));
      const applied = this.applied(rows, type, q);
      const { results } = applyQuery(this, applied.rows, applied.type, {
        ...q,
        top: undefined,
        skip: undefined,
      });
      return {
        status: 200,
        contentType: "text/plain",
        body: String(results.length),
      };
    }

    if (row === undefined) {
      // Collection
      switch (method) {
        case "GET": {
          const tracked =
            segments.length === 1 && this.tracksChanges(opts.prefer, q);
          if (tracked)
            opts.deltaLink = () =>
              requestLink(path, query, {
                $skiptoken: undefined,
                $deltatoken: this.deltaTokens.issue(
                  setName,
                  this.store.rows(setName),
                ),
              });
          const response = this.collectionResponse(
            rows,
            setName,
            type,
            q,
            opts,
          );
          const applied = [
            ...(pageSize.applied ? [`odata.maxpagesize=${pageSize.size}`] : []),
            ...(tracked ? ["odata.track-changes"] : []),
          ];
          if (applied.length)
            response.headers = {
              ...response.headers,
              "Preference-Applied": applied.join(", "),
            };
          return response;
        }
        case "POST": {
          const parent = parentForCreate;
          const preset: Row = parent
            ? Object.fromEntries(
                parent.nav.join.map(([src, tgt]) => [tgt, parent.row[src]]),
              )
            : {};
          const created = this.model.entitySets[setName].draft
            ? this.drafts.create(setName, type, parentForCreate, body, preset)
            : create(this, setName, type, body, preset);
          // Through a link set: the new entity is linked to the one it's created under
          if (parent && "links" in parent.nav && parent.nav.links)
            addLink(this.model, this.store, parent.nav, parent.row, created);
          const location = this.entityUri(setName, type, created);
          if (wantsMinimal)
            return {
              status: 204,
              headers: {
                Location: location,
                "Preference-Applied": "return=minimal",
              },
            };
          return protocol.entity(
            this,
            created,
            setName,
            type,
            q,
            201,
            { Location: location },
            opts,
          );
        }
        default:
          throw new HttpError(405, `${method} not allowed on a collection`);
      }
    }

    // Single entity
    switch (method) {
      case "GET": {
        const computed = this.computed({ rows: [row], type }, q);
        return protocol.entity(
          this,
          computed.rows[0],
          setName,
          computed.type,
          q,
          200,
          undefined,
          opts,
        );
      }
      case "PUT":
      case "PATCH":
      case "MERGE": {
        const draft = this.model.entitySets[setName].draft;
        checkIfMatch(this.model, setName, row, headers, this.etags, !draft);
        const updated = update(
          this,
          setName,
          type,
          this.keyOf(type, row),
          draft ? this.drafts.beforeUpdate(type, row, body) : body,
          method === "PUT",
          !!draft,
        );
        renewETag(this.model, setName, type, updated);
        if (draft) this.drafts.afterUpdate(updated);
        if (wantsRepresentation)
          return protocol.entity(
            this,
            updated,
            setName,
            type,
            q,
            200,
            { "Preference-Applied": "return=representation" },
            opts,
          );
        // The new ETag, so the client can send the next change without reading it first
        const etag = this.etag(setName, updated);
        return {
          status: 204,
          headers: {
            ...(wantsMinimal ? { "Preference-Applied": "return=minimal" } : {}),
            ...(etag ? { ETag: etag } : {}),
          },
        };
      }
      case "DELETE": {
        const draft = this.model.entitySets[setName].draft;
        checkIfMatch(this.model, setName, row, headers, this.etags, !draft);
        if (draft) this.drafts.delete(setName, type, row);
        else deleteEntity(this, setName, type, this.keyOf(type, row));
        return { status: 204 };
      }
      default:
        throw new HttpError(405, `${method} not allowed on an entity`);
    }
  }
}

export { ODataService };
