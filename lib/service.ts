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
import { HttpError } from "./query.ts";
import { draftMatch, Drafts } from "./draft.ts";
import { etagOf, checkIfMatch, renewETag } from "./etag.ts";
import type { ETagMode } from "./etag.ts";
import { parseSegments, parseKey } from "./resource-path.ts";
import { applyQuery } from "./apply-query.ts";
import { applyTransformations, holdsEntities } from "./aggregation.ts";
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

// What a protocol module supplies (protocols/v2 and v4): how literals are read and keys
// written, and what each kind of response looks like
export interface Protocol extends LiteralSyntax {
  version: ODataVersion;
  // Sent with every response (DataServiceVersion, OData-Version)
  headers: Record<string, string>;
  keyLiteral(value: PropertyValue, prop: Property): string;
  parseQueryOptions(query: Record<string, unknown>): QueryNode;
  serviceDocument(svc: ODataService): ODataResponse;
  collection(
    svc: ODataService,
    result: { rows: Row[]; count?: number },
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
  // entities: the entity type and rows of the collection $apply ran on; a result row that
  // is one of them is written as an entity, with node's $select and $expand
  aggregated?(
    svc: ODataService,
    result: { rows: Row[]; count?: number },
    setName: string,
    type: EntityType,
    node: QueryNode,
    entities: { type: EntityType; rows: Set<Row> },
    opts?: ResponseOptions,
  ): ODataResponse;
  // A single-valued navigation or operation result that is empty
  nullEntity(): ODataResponse;
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
  error(status: number, message: string): ODataResponse;
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
}

// The request headers dispatch reads (accept, prefer)
export type RequestHeaders = Record<string, string | string[] | undefined>;

class ODataService {
  model: Model;
  store: Store;
  protocol: Protocol;
  servicePath: string;
  metadataXml: string;
  log: (message: string) => void;
  rules: Rules;
  etags: ETagMode;
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
  }: ServiceOptions) {
    this.model = model;
    this.store = store;
    this.protocol = protocol;
    this.servicePath = servicePath;
    this.metadataXml = metadataXml;
    this.log = log;
    this.rules = rules;
    this.etags = etags;
    // The operations as this protocol serves them (see operationViews in metadata.ts)
    this.operations = model.operationViews[protocol.version];
    this.drafts = new Drafts(this);
  }

  entitySet(name: string): { set: EntitySet; type: EntityType } {
    const es = this.model.entitySets[name];
    if (!es) throw new HttpError(404, `Entity set ${name} not found`);
    return { set: es, type: this.model.entityTypes[es.entityType] };
  }

  keyOf(entityType: EntityType, row: Row): Key {
    return Object.fromEntries(entityType.keys.map((k) => [k, row[k]]));
  }

  // The entity's ETag, for an entity set that has them (see etag.ts)
  etag(setName: string, row: Row): string | undefined {
    return etagOf(this.model, setName, row);
  }

  entityUri(setName: string, entityType: EntityType, row: Row): string {
    const lit = (k: string) =>
      this.protocol.keyLiteral(row[k], entityType.properties[k]);
    const keyText =
      entityType.keys.length === 1
        ? lit(entityType.keys[0])
        : entityType.keys.map((k) => `${k}=${lit(k)}`).join(",");
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
    const { rows, type } = this.related(row, entityType, nav);
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
    const reason = type.disabledNavigations?.[name];
    if (reason)
      throw new HttpError(
        501,
        `Navigation ${name} is not supported: ${reason}`,
      );
    return type.navigations[name] || type.draftNavigations?.[name];
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
        return this.protocol.error(e.status, e.message);
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

    // Operation imports: /Name, /Name(a=1) (V4 functions), /Name?a=1 (V2)
    const first = segments[0].name;
    const imported =
      !this.model.entitySets[first] && operationImport(this, first);
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
    if (!this.model.entitySets[first])
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
      { row: Row; type: EntityType; nav: AnyNavigation } | undefined =
      undefined;
    if (key) {
      row = this.store.find(setName, type, key);
      if (!row) throw new HttpError(404, `${type.name} not found`);
    }

    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      // Bound operations: Set(key)/NS.Name or Set/NS.Name, with (a=1) for V4 functions
      const op =
        !this.navigation(type, seg.name) &&
        !type.properties[seg.name] &&
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
        const prop = type.properties[seg.name];
        if (!prop || i !== segments.length - 1)
          throw new HttpError(
            404,
            `${seg.name} is not a property or navigation of ${type.name}`,
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
      parentForCreate = { row, type, nav };
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

    // $apply turns the collection into rows of a type of its own (see aggregation.ts), which
    // the other query options then work on. Those that are still entities can be expanded.
    const entities = { type, rows: new Set(rows) };
    if (q.apply) {
      if (method !== "GET" || row !== undefined)
        throw new HttpError(400, "$apply applies to reading a collection only");
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
      ({ rows, type } = applyTransformations(this, rows, type, q.apply));
    }

    if (wantCount) {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      const { results } = applyQuery(this, rows, type, {
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
          const { results, count } = applyQuery(this, rows, type, q);
          if (q.apply)
            return protocol.aggregated!(
              this,
              { rows: results, count },
              setName,
              type,
              q,
              entities,
              opts,
            );
          return protocol.collection(
            this,
            { rows: results, count },
            setName,
            type,
            q,
            opts,
          );
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
      case "GET":
        return protocol.entity(
          this,
          row,
          setName,
          type,
          q,
          200,
          undefined,
          opts,
        );
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
