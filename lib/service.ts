// The generic OData request handler, one instance per (protocol, service path), all
// sharing one store. Everything here is driven by the parsed model; the protocol object
// decides how literals are read and how responses are written.
//
// dispatch(method, path, query, body, headers) -> Promise<{ status, body?, contentType?,
// headers? }> is the entry point of the Express routes: it runs the request in its turn in
// the queue (see queue.ts), through execute(), which $batch calls for its parts. That hands
// the request to dispatch.ts, which walks the resource path, and saves what it changed.
// The service keeps what every part of the work shares: the model's lookups,
// navigations, and a collection's response.
import { HttpError, own } from "./query.ts";
import { draftMatch, Drafts } from "./draft.ts";
import { etagOf } from "./etag.ts";
import type { ETagMode } from "./etag.ts";
import { applyQuery } from "./apply-query.ts";
import { applyCompute } from "./compute.ts";
import { DeltaTokens } from "./delta.ts";
import { linkedRows } from "./links.ts";
import { paging } from "./paging.ts";
import { handle } from "./dispatch.ts";
import type {
  CollectionResult,
  Protocol,
  RequestHeaders,
  Rules,
} from "./protocol.ts";
import { applyTransformations, holdsEntities } from "./aggregation.ts";
import { isHierarchyRow } from "./hierarchy.ts";
import type {
  AnyNavigation,
  EntitySet,
  EntityType,
  Key,
  Model,
  ODataResponse,
  OperationView,
  QueryNode,
  ResponseOptions,
  Row,
} from "./model.ts";
import type { Change, Store } from "./store.ts";
import type { Queue } from "./queue.ts";
import { netChanges, type Persistence } from "./persistence.ts";

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
  // Runs the requests of every service on the store one at a time (see queue.ts)
  queue: Queue;
  // Saves each outermost commit, if anything does (see persistence.ts)
  persistence?: Persistence;
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
  queue: Queue;
  persistence: Persistence | undefined;
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
    queue,
    persistence,
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
    this.queue = queue;
    this.persistence = persistence;
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
    // V2 has the draft administrative data CAP contains in each draft in a set of its own
    const adminSet = this.model.draftAdminSetV2;
    if (
      this.protocol.version === "2.0" &&
      adminSet?.entityType === entityType.fullName
    )
      return `${this.servicePath}/${adminSet.name}(${keyText})`;
    const contained = this.model.entitySets[setName]?.contained;
    if (contained) {
      const parent = this.entitySet(contained.parentSet);
      const nav = parent.type.navigations[contained.navigation];
      const [parentRow] = this.store.lookup(
        contained.parentSet,
        nav.join.map(([src]) => src),
        nav.join.map(([, tgt]) => row[tgt]),
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
      .lookup(
        nav.targetSet,
        nav.join.map(([, tgt]) => tgt),
        nav.join.map(([src]) => row[src]),
      )
      .filter((t) => draftMatch(nav, row, t));
    return { ...target, rows };
  }

  // Related rows for an $expand node, with the node's own $filter/$orderby/$top/$skip applied.
  // page: server-driven paging for an expanded collection (see paging.ts), the page's size
  // and the link to the rest, which nextLink is when rows are left out
  expandRows(
    row: Row,
    entityType: EntityType,
    nav: AnyNavigation,
    node: QueryNode,
    page?: ResponseOptions["page"],
  ): {
    rows: readonly Row[];
    count?: number;
    type: EntityType;
    nextLink?: string;
  } {
    const { rows, type } = this.computed(
      this.related(row, entityType, nav),
      node,
    );
    const { results, count } = applyQuery(this, rows, type, {
      ...node,
      count: node.count,
    });
    if (!page || !nav.isCollection) return { rows: results, count, type };
    const paged = paging(
      results,
      { ...node, skiptoken: undefined },
      { ieee754: false, prefer: "", page },
    );
    return { ...paged, count, type };
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
    rows: readonly Row[],
    type: EntityType,
    q: QueryNode,
  ): {
    rows: readonly Row[];
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
      // * is every navigation (see expandAll in protocols/v4.ts)
      if (name !== "*" && !this.navigation(type, name))
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
    { rows, type }: { rows: readonly Row[]; type: EntityType },
    q: QueryNode,
  ): { rows: readonly Row[]; type: EntityType } {
    if (!q.compute) return { rows, type };
    if (q.apply)
      throw new HttpError(501, "$compute with $apply is not supported");
    return applyCompute(this, rows, type, q.compute);
  }

  // A collection's response: an entity set's, a navigation's or an operation's, after its
  // query options, $apply first
  collectionResponse(
    rows: readonly Row[],
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

  // --- Dispatch --------------------------------------------------------------------------

  // A request, in its turn in the queue
  dispatch(
    method: string,
    path: string,
    query: Record<string, unknown> = {},
    body?: unknown,
    headers: RequestHeaders = {},
  ): Promise<ODataResponse> {
    return this.queue.run(
      () => this.execute(method, path, query, body, headers),
      method !== "GET" && method !== "HEAD",
    );
  }

  // A request, run now: by dispatch(), and by $batch for its parts, the batch having taken
  // its turn in the queue
  async execute(
    method: string,
    path: string,
    query: Record<string, unknown> = {},
    body?: unknown,
    headers: RequestHeaders = {},
  ): Promise<ODataResponse> {
    // Each request is a transaction: an error leaves the store as it found it, whatever
    // the request had changed before it failed
    const mark = this.store.begin();
    let response: ODataResponse;
    try {
      response = handle(this, method, path, query, body, headers);
    } catch (e) {
      this.store.rollback(mark);
      if (e instanceof HttpError)
        return this.protocol.error(e.status, e.message, e.code);
      console.error(e);
      return this.protocol.error(500, (e as Error).message);
    }
    if (response.status >= 400) {
      this.store.rollback(mark);
      return response;
    }
    // Inside a changeset the commit is the changeset's to save (see batch.ts)
    const changes = this.store.commit(mark);
    return (changes && (await this.save(changes))) || response;
  }

  // Saves the changes of an outermost commit (see Store.commit), and settles it: kept once
  // saved, undone when they couldn't be. Returns the error to answer with then.
  async save(changes: Change[]): Promise<ODataResponse | undefined> {
    try {
      if (this.persistence && changes.length)
        await this.persistence.commit(netChanges(this.model, changes));
    } catch (e) {
      this.store.settle(false);
      // Another server saved first: the turn runs again, caught up (see sharedTurn). Or the
      // backend says what to answer (busy: 503).
      if (e instanceof HttpError) throw e;
      console.error(e);
      return this.protocol.error(
        500,
        `The changes could not be saved: ${(e as Error).message}`,
      );
    }
    this.store.settle(true);
    return undefined;
  }
}

export { ODataService };
