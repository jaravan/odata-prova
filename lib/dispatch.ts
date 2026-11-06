// A request to a service, from its path to its answer (see dispatch in service.ts): handle
// reads the request and walks its resource path, the entity set and then its navigations,
// and hands it to what answers on where the walk ends: an operation (operations.ts), links
// ($ref and $links, see references.ts), a property, a collection, or an entity.

import { specialFloat, withPrecision } from "./types.ts";
import { HttpError, checkSelect, decodeUrl, newNode, own } from "./query.ts";
import { checkIfMatch, notModified, renewETag } from "./etag.ts";
import { parseSegments, parseKey, type Segment } from "./resource-path.ts";
import { applyQuery } from "./apply-query.ts";
import { deltaResponse, snapshot, tracksChanges } from "./delta.ts";
import { addLink } from "./links.ts";
import { referenceRequest } from "./references.ts";
import { pageSizeFor, requestLink } from "./paging.ts";
import { create, update, deleteEntity } from "./writes.ts";
import {
  operationImport,
  boundOperation,
  callOperation,
} from "./operations.ts";
import type { RequestHeaders } from "./protocol.ts";
import type { ODataService } from "./service.ts";
import type {
  AnyNavigation,
  EntityType,
  ODataResponse,
  Property,
  PropertyValue,
  QueryNode,
  ResponseOptions,
  Row,
} from "./model.ts";

// The navigations a deep insert's body created entities through, nested as in the body: its
// response is expanded as deep (OData 4.01), so the client gets them as the server set them.
// A navigation $expand names keeps its options; V2's links by reference ({ __metadata })
// create nothing.
function deepInsertExpand(
  svc: ODataService,
  type: EntityType,
  body: unknown,
  node: QueryNode,
): QueryNode {
  if (!body || typeof body !== "object") return node;
  const fields = body as Record<string, unknown>;
  const expand = { ...node.expand };
  for (const nav of Object.values(type.navigations)) {
    let value = own(fields, nav.name);
    if (
      value &&
      typeof value === "object" &&
      Array.isArray((value as { results?: unknown }).results)
    )
      value = (value as { results: unknown[] }).results;
    const created = (
      Array.isArray(value) ? (value as unknown[]) : [value]
    ).filter(
      (v): v is object =>
        !!v &&
        typeof v === "object" &&
        Object.keys(v).some((k) => k !== "__metadata"),
    );
    if (!created.length || expand[nav.name]) continue;
    const target = svc.model.entityTypes[nav.targetType];
    expand[nav.name] = created.reduce<QueryNode>(
      (n, v) => deepInsertExpand(svc, target, v, n),
      newNode(),
    );
  }
  return { ...node, expand };
}

// A URL as a header can hold it: a key's spaces, control and non-ASCII characters
// percent-encoded, as UTF-8 bytes (a lone surrogate too, as U+FFFD)
const headerUrl = (url: string) =>
  url.replace(/[^\x21-\x7E]/gu, (c) =>
    [...Buffer.from(c)]
      .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
      .join(""),
  );

// The request as handle has read it
interface Request {
  svc: ODataService;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  headers: RequestHeaders;
  q: QueryNode;
  opts: ResponseOptions;
  segments: Segment[];
  pageSize: { size: number; applied: boolean };
  wantsMinimal: boolean;
  wantsRepresentation: boolean;
}

// Where the walk ended: an entity set's or a navigation's rows, and parent, the entity the
// last navigation started from
interface Position {
  setName: string;
  type: EntityType;
  rows: readonly Row[];
  parent?: { row: Row; type: EntityType; nav: AnyNavigation; setName: string };
}

function handle(
  svc: ODataService,
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: unknown,
  headers: RequestHeaders,
): ODataResponse {
  // Both decoded alike: a service path is encoded for the URLs it goes in
  const root = decodeUrl(svc.servicePath);
  if (!path.startsWith(root)) throw new HttpError(404, `Not found: ${path}`);
  const resourcePath = path
    .slice(root.length)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const protocol = svc.protocol;
  const opts: ResponseOptions = {
    ieee754: /IEEE754Compatible=true/i.test(
      `${String(headers.accept || "")} ${String(query.$format || "")}`,
    ),
    prefer: String(headers.prefer || ""),
  };
  const pageSize = pageSizeFor(svc.pageSize, protocol.version, opts.prefer);
  if (method === "GET" && pageSize.size)
    opts.page = {
      size: pageSize.size,
      link: (skiptoken) => requestLink(path, query, { $skiptoken: skiptoken }),
    };
  const wantsMinimal = /return=minimal/i.test(opts.prefer);
  const wantsRepresentation = /return=representation/i.test(opts.prefer);

  if (resourcePath === "") {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    return protocol.serviceDocument(svc);
  }
  // A POST has its own route: one here is inside a $batch, where it names nothing
  if (resourcePath === "$batch" && method !== "POST")
    throw new HttpError(405, "$batch is a POST");
  if (resourcePath === "$metadata") {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    return {
      status: 200,
      contentType: "application/xml",
      body: svc.metadataXml,
    };
  }

  for (const [name, value] of Object.entries(query))
    if (Array.isArray(value) && /^[$!]/.test(name))
      throw new HttpError(400, `${name} is given more than once`);
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

  // /$count, /$value and /$ref alone: what's left names nothing
  if (!segments.length)
    throw new HttpError(404, `${resourcePath} needs a resource to apply to`);

  const request: Request = {
    svc,
    method,
    path,
    query,
    body,
    headers,
    q,
    opts,
    segments,
    pageSize,
    wantsMinimal,
    wantsRepresentation,
  };

  // Operation imports: /Name, /Name(a=1) (V4 functions), /Name?a=1 (V2)
  const first = segments[0].name;
  const imported =
    !own(svc.model.entitySets, first) && operationImport(svc, first);
  if (imported) {
    if (segments.length > 1 || wantCount || wantValue)
      throw new HttpError(
        501,
        `Path segments after ${first} are not supported`,
      );
    return callOperation(
      svc,
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
  if (
    protocol.version === "2.0" &&
    first === svc.model.draftAdminSetV2?.name &&
    !wantCount &&
    !wantValue &&
    !wantRefs
  )
    return draftAdminRequest(request);
  // A contained set is reached only through its navigation (see resolveContainment)
  if (
    !own(svc.model.entitySets, first) ||
    svc.model.entitySets[first].contained
  )
    throw new HttpError(404, `${first} is not an entity set or operation`);

  // Walk: entity set, then navigation properties, keeping the current row/collection.
  const start = svc.entitySet(first);
  let type = start.type;
  let setName = start.set.name;
  let rows = svc.store.rows(setName);
  let row: Row | undefined = undefined; // defined when the current position is a single entity
  const key = parseKey(segments[0].keyText, type, svc.protocol, svc.model);
  // When POSTing to Parent(key)/Nav
  let parentForCreate:
    | { row: Row; type: EntityType; nav: AnyNavigation; setName: string }
    | undefined = undefined;
  if (key) {
    row = svc.store.find(setName, type, key);
    if (!row) throw new HttpError(404, `${type.name} not found`);
  }

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    // Bound operations: Set(key)/NS.Name or Set/NS.Name, with (a=1) for V4 functions
    const op =
      !svc.navigation(type, seg.name) &&
      !own(type.properties, seg.name) &&
      boundOperation(svc, seg.name, type, row === undefined);
    if (op) {
      if (i !== segments.length - 1 || wantCount || wantValue)
        throw new HttpError(
          501,
          `Path segments after ${seg.name} are not supported`,
        );
      return callOperation(
        svc,
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
    const nav = svc.navigation(type, seg.name);
    if (!nav) {
      // Plain property access: Set(key)/Prop or Set(key)/Prop/$value, and on through a
      // complex value: Set(key)/Address/City
      let prop = own(type.properties, seg.name);
      let holder: Row | null = row;
      let field = "";
      if (prop?.isCollection && i < segments.length - 1)
        throw new HttpError(
          400,
          `${prop.name} is a collection: a path can't go on through it`,
        );
      while (prop?.complexType && i < segments.length - 1) {
        const next: Property | undefined = own(
          prop.complexType.properties,
          segments[i + 1].name,
        );
        if (!next)
          throw new HttpError(
            404,
            `${segments[i + 1].name} is not a field of ${prop.complexType.name}`,
          );
        holder = (holder?.[prop.name] ?? null) as Row | null;
        field += `/${prop.name}`;
        prop = next;
        i++;
        if (prop.isCollection && i < segments.length - 1)
          throw new HttpError(
            400,
            `${prop.name} is a collection: a path can't go on through it`,
          );
      }
      if (!prop || i !== segments.length - 1)
        throw new HttpError(
          404,
          `${seg.name} is not a property or navigation of ${type.name}`,
        );
      if (wantRefs)
        throw new HttpError(400, `${seg.name} is a property, not a navigation`);
      return propertyRequest(
        request,
        { setName, type, row, holder, field },
        prop,
        wantValue,
        wantCount,
      );
    }
    if (nav.draft === "admin" && method !== "GET")
      throw new HttpError(405, `${nav.name} is read-only`);
    const related = svc.related(row, type, nav);
    parentForCreate = { row, type, nav, setName };
    setName = nav.targetSet;
    type = related.type;
    rows = related.rows;
    row = undefined;
    const segKey = parseKey(seg.keyText, type, svc.protocol, svc.model);
    if (segKey) {
      const segType = type;
      row = rows.find((r) => svc.store.matchesKey(segType, r, segKey));
      if (!row) throw new HttpError(404, `${type.name} not found`);
    } else if (!nav.isCollection) {
      row = rows[0];
      checkOneEntity(q);
      if (!row && method === "GET") return protocol.nullEntity();
    }
  }

  if (wantRefs) {
    if (!parentForCreate || segments.length < 2)
      throw new HttpError(400, "Links are a navigation's: Set(key)/Nav/$ref");
    return referenceRequest(
      svc,
      method,
      parentForCreate,
      row,
      !!segments.at(-1)!.keyText,
      body,
      query,
    );
  }

  // A property's /$value was answered above: this is an entity's or a collection's, a media
  // resource's content, which the server has none of
  if (wantValue)
    throw new HttpError(
      501,
      "$value of an entity (its media content) is not supported; a property's /$value is",
    );

  if (q.deltatoken !== undefined) {
    if (method !== "GET" || row !== undefined || segments.length !== 1)
      throw new HttpError(
        400,
        "A delta token applies to reading an entity set",
      );
    return deltaResponse(svc, setName, type, q, opts, (token) =>
      requestLink(path, query, {
        $skiptoken: undefined,
        ...protocol.deltaOption!(token),
      }),
    );
  }

  if (q.apply && (method !== "GET" || row !== undefined))
    throw new HttpError(400, "$apply applies to reading a collection only");
  if (row !== undefined) checkOneEntity(q);

  if (wantCount && row !== undefined)
    throw new HttpError(400, "$count applies to a collection, not an entity");
  if (wantCount) return countRequest(request, { setName, type, rows });

  const at = { setName, type, rows, parent: parentForCreate };
  return row === undefined
    ? collectionRequest(request, at)
    : entityRequest(request, { ...at, row });
}

// V2's set of the draft administrative data CAP contains in each draft (see draftAdminSetV2
// in draft.ts): its records, read-only, as an entity's DraftAdministrativeData links to them
function draftAdminRequest(request: Request): ODataResponse {
  const { svc, method, segments, q, opts } = request;
  const { name, entityType } = svc.model.draftAdminSetV2!;
  if (method !== "GET") throw new HttpError(405, `${name} is read-only`);
  if (segments.length > 1)
    throw new HttpError(
      404,
      `${segments[1].name} is not a property or navigation of ${name}`,
    );
  const type = svc.model.entityTypes[entityType];
  const rows = svc.drafts.admins();
  const key = parseKey(segments[0].keyText, type, svc.protocol, svc.model);
  if (!key) return svc.collectionResponse(rows, name, type, q, opts);
  const row = rows.find((r) => svc.store.matchesKey(type, r, key));
  if (!row) throw new HttpError(404, `${type.name} not found`);
  return entityRequest(request, { setName: name, type, rows, row });
}

// A property of an entity: Set(key)/Prop, its raw value with /$value, or a collection's size
// with /$count
// What only a collection has. Left to pass on one entity, a mistake in it would go unseen.
const COLLECTION_OPTIONS = [
  "filter",
  "orderby",
  "search",
  "top",
  "skip",
] as const;

function checkOneEntity(q: QueryNode): void {
  for (const option of COLLECTION_OPTIONS)
    if (q[option] !== undefined)
      throw new HttpError(400, `$${option} applies to a collection`);
  if (q.count) throw new HttpError(400, "$count applies to a collection");
}

function propertyRequest(
  request: Request,
  at: {
    setName: string;
    type: EntityType;
    row: Row;
    // What holds the property, a complex value on the way to it, and the path to that
    holder: Row | null;
    field: string;
  },
  prop: Property,
  wantValue: boolean,
  wantCount: boolean,
): ODataResponse {
  const { svc, method, q, opts } = request;
  const { setName, type, row, holder, field } = at;
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  if (q.apply)
    throw new HttpError(400, "$apply applies to reading a collection only");
  // A collection property pages; there's nothing else to do to a value
  const refused = prop.isCollection
    ? (["filter", "orderby", "search"] as const)
    : COLLECTION_OPTIONS;
  for (const option of refused)
    if (q[option] !== undefined)
      throw new HttpError(400, `$${option} doesn't apply to ${prop.name}`);
  if (q.count)
    throw new HttpError(400, `$count=true doesn't apply to ${prop.name}`);
  if (q.select || Object.keys(q.expand).length)
    throw new HttpError(400, `$select and $expand don't apply to ${prop.name}`);
  let value = holder?.[prop.name] ?? null;
  if (prop.isCollection && Array.isArray(value) && !wantCount) {
    const start = q.skip ?? 0;
    value = value.slice(start, q.top === undefined ? undefined : start + q.top);
  }
  if (wantCount && !prop.isCollection)
    throw new HttpError(
      400,
      `$count applies to a collection, not ${prop.name}`,
    );
  // V2 has no collection properties: its property() answers for that
  if (wantCount && svc.protocol.version === "4.0")
    return {
      status: 200,
      contentType: "text/plain",
      body: String((value as PropertyValue[]).length),
    };
  if (wantValue && (prop.isCollection || prop.complexType))
    throw new HttpError(400, `$value applies to a primitive, not ${prop.name}`);
  // V4's null property has no body; V2 keeps its { d: { Name: null } }
  if (value === null && svc.protocol.version === "4.0") return { status: 204 };
  if (
    wantValue &&
    value !== null &&
    /^Edm\.(DateTimeOffset|TimeOfDay)$/.test(prop.type)
  )
    return {
      status: 200,
      contentType: "text/plain",
      body: withPrecision(value, prop.precision),
    };
  if (wantValue && prop.type === "Edm.Binary" && value !== null)
    return {
      status: 200,
      contentType: "application/octet-stream",
      body: Buffer.from(String(value), "base64"),
    };
  if (wantValue)
    return {
      status: 200,
      contentType: "text/plain",
      body: value === null ? "" : specialFloat(value) || String(value),
    };
  return svc.protocol.property(
    svc,
    `${svc.entityUri(setName, type, row)}${field}`,
    prop,
    value,
    opts,
  );
}

// A collection's /$count: the rows its $filter, $search and $apply leave, without $top and
// $skip
function countRequest(request: Request, at: Position): ODataResponse {
  const { svc, method, q } = request;
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  checkSelect(svc, at.type, q);
  const { rows, type } = svc.computed(at, q);
  const applied = svc.applied(rows, type, q);
  const { results } = applyQuery(svc, applied.rows, applied.type, {
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

// A collection: GET reads it, POST creates an entity in it
function collectionRequest(request: Request, at: Position): ODataResponse {
  const {
    svc,
    method,
    path,
    query,
    body,
    q,
    opts,
    segments,
    pageSize,
    wantsMinimal,
  } = request;
  const { setName, type, rows, parent: parentForCreate } = at;
  const protocol = svc.protocol;
  switch (method) {
    case "GET": {
      const tracked =
        segments.length === 1 && tracksChanges(svc, setName, opts.prefer, q);
      if (tracked)
        opts.deltaLink = () =>
          requestLink(path, query, {
            $skiptoken: undefined,
            ...protocol.deltaOption!(
              svc.deltaTokens.issue(
                snapshot(svc, setName, type, svc.store.rows(setName), q),
              ),
            ),
          });
      if (svc.model.entitySets[setName]?.contained && parentForCreate)
        opts.containedPath = `${svc
          .entityUri(
            parentForCreate.setName,
            parentForCreate.type,
            parentForCreate.row,
          )
          .slice(svc.servicePath.length + 1)}/${parentForCreate.nav.name}`;
      const response = svc.collectionResponse(rows, setName, type, q, opts);
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
      checkOneEntity(q);
      checkSelect(svc, type, q);
      const parent = parentForCreate;
      const preset: Row = parent
        ? Object.fromEntries(
            parent.nav.join.map(([src, tgt]) => [tgt, parent.row[src]]),
          )
        : {};
      const created = svc.model.entitySets[setName].draft
        ? svc.drafts.create(setName, type, parentForCreate, body, preset)
        : create(svc, setName, type, body, preset);
      // Through a link set: the new entity is linked to the one it's created under
      if (parent && "links" in parent.nav && parent.nav.links)
        addLink(svc.model, svc.store, parent.nav, parent.row, created);
      const location = headerUrl(svc.entityUri(setName, type, created));
      if (wantsMinimal)
        return {
          status: 204,
          headers: {
            Location: location,
            // With no body, this says which entity it is, in V4
            ...(protocol.version === "4.0"
              ? { "OData-EntityId": location }
              : {}),
            "Preference-Applied": "return=minimal",
          },
        };
      return protocol.entity(
        svc,
        created,
        setName,
        type,
        deepInsertExpand(svc, type, body, q),
        201,
        { Location: location },
        opts,
      );
    }
    default:
      throw new HttpError(405, `${method} not allowed on a collection`);
  }
}

// One entity: GET reads it, PUT, PATCH and MERGE change it, DELETE deletes it
function entityRequest(
  request: Request,
  at: Position & { row: Row },
): ODataResponse {
  const {
    svc,
    method,
    body,
    headers,
    q,
    opts,
    wantsMinimal,
    wantsRepresentation,
  } = request;
  const { setName, type, row } = at;
  const protocol = svc.protocol;
  switch (method) {
    case "GET": {
      if (notModified(svc.model, setName, row, headers, svc.etags))
        return {
          status: 304,
          headers: {
            ...(svc.etag(setName, row)
              ? { ETag: svc.etag(setName, row)! }
              : {}),
          },
        };
      const computed = svc.computed({ rows: [row], type }, q);
      return protocol.entity(
        svc,
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
      checkSelect(svc, type, q);
      const draft = svc.model.entitySets[setName].draft;
      checkIfMatch(svc.model, setName, row, headers, svc.etags, !draft);
      const updated = update(
        svc,
        setName,
        type,
        svc.keyOf(type, row),
        draft ? svc.drafts.beforeUpdate(setName, type, row, body) : body,
        method === "PUT",
        !!draft,
      );
      renewETag(svc.store, setName, type, updated);
      if (draft) svc.drafts.afterUpdate(updated);
      if (wantsRepresentation)
        return protocol.entity(
          svc,
          updated,
          setName,
          type,
          q,
          200,
          { "Preference-Applied": "return=representation" },
          opts,
        );
      // The new ETag, so the client can send the next change without reading it first
      const etag = svc.etag(setName, updated);
      return {
        status: 204,
        headers: {
          ...(wantsMinimal ? { "Preference-Applied": "return=minimal" } : {}),
          ...(etag ? { ETag: etag } : {}),
        },
      };
    }
    case "DELETE": {
      if (q.select || Object.keys(q.expand).length)
        throw new HttpError(400, "$select and $expand don't apply to a DELETE");
      const draft = svc.model.entitySets[setName].draft;
      checkIfMatch(svc.model, setName, row, headers, svc.etags, !draft);
      if (draft) svc.drafts.delete(setName, type, row);
      else deleteEntity(svc, setName, type, svc.keyOf(type, row));
      return { status: 204 };
    }
    default:
      throw new HttpError(405, `${method} not allowed on an entity`);
  }
}

export { handle };
