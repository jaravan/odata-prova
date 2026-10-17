// A request to a service, from its path to its answer (see dispatch in service.ts): handle
// reads the request and walks its resource path, the entity set and then its navigations,
// and hands it to what answers on where the walk ends: an operation (operations.ts), links
// ($ref and $links, see references.ts), a property, a collection, or an entity.

import { specialFloat } from "./types.ts";
import { HttpError, own } from "./query.ts";
import { checkIfMatch, renewETag } from "./etag.ts";
import { parseSegments, parseKey, type Segment } from "./resource-path.ts";
import { applyQuery } from "./apply-query.ts";
import { deltaResponse, tracksChanges } from "./delta.ts";
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
  QueryNode,
  ResponseOptions,
  Row,
} from "./model.ts";

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
  rows: Row[];
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
  if (!path.startsWith(svc.servicePath))
    throw new HttpError(404, `Not found: ${path}`);
  const resourcePath = path
    .slice(svc.servicePath.length)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  const protocol = svc.protocol;
  const opts: ResponseOptions = {
    ieee754: /IEEE754Compatible=true/i.test(String(headers.accept || "")),
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
  if (resourcePath === "$metadata") {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    return {
      status: 200,
      contentType: "application/xml",
      body: svc.metadataXml,
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
  const key = parseKey(segments[0].keyText, type, svc.protocol);
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
      // Plain property access: Set(key)/Prop or Set(key)/Prop/$value
      const prop = own(type.properties, seg.name);
      if (!prop || i !== segments.length - 1)
        throw new HttpError(
          404,
          `${seg.name} is not a property or navigation of ${type.name}`,
        );
      if (wantRefs)
        throw new HttpError(400, `${seg.name} is a property, not a navigation`);
      return propertyRequest(request, { setName, type, row }, prop, wantValue);
    }
    if (nav.draft === "admin" && method !== "GET")
      throw new HttpError(405, `${nav.name} is read-only`);
    const related = svc.related(row, type, nav);
    parentForCreate = { row, type, nav, setName };
    setName = nav.targetSet;
    type = related.type;
    rows = related.rows;
    row = undefined;
    const segKey = parseKey(seg.keyText, type, svc.protocol);
    if (segKey) {
      const segType = type;
      row = rows.find((r) => svc.store.matchesKey(segType, r, segKey));
      if (!row) throw new HttpError(404, `${type.name} not found`);
    } else if (!nav.isCollection) {
      row = rows[0];
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

  if (q.deltatoken !== undefined) {
    if (method !== "GET" || row !== undefined || segments.length !== 1)
      throw new HttpError(400, "$deltatoken applies to reading an entity set");
    return deltaResponse(svc, setName, type, q, opts, (token) =>
      requestLink(path, query, {
        $skiptoken: undefined,
        $deltatoken: token,
      }),
    );
  }

  if (q.apply && (method !== "GET" || row !== undefined))
    throw new HttpError(400, "$apply applies to reading a collection only");

  if (wantCount) return countRequest(request, { setName, type, rows });

  const at = { setName, type, rows, parent: parentForCreate };
  return row === undefined
    ? collectionRequest(request, at)
    : entityRequest(request, { ...at, row });
}

// A property of an entity: Set(key)/Prop, or its raw value with /$value
function propertyRequest(
  request: Request,
  at: { setName: string; type: EntityType; row: Row },
  prop: Property,
  wantValue: boolean,
): ODataResponse {
  const { svc, method, q, opts } = request;
  const { setName, type, row } = at;
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  if (q.apply)
    throw new HttpError(400, "$apply applies to reading a collection only");
  const value = row[prop.name];
  if (wantValue)
    return {
      status: 200,
      contentType: "text/plain",
      body: value === null ? "" : specialFloat(value) || String(value),
    };
  return svc.protocol.property(
    svc,
    svc.entityUri(setName, type, row),
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
        segments.length === 1 && tracksChanges(svc, opts.prefer, q);
      if (tracked)
        opts.deltaLink = () =>
          requestLink(path, query, {
            $skiptoken: undefined,
            $deltatoken: svc.deltaTokens.issue(
              setName,
              svc.store.rows(setName),
            ),
          });
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
      const location = svc.entityUri(setName, type, created);
      if (wantsMinimal)
        return {
          status: 204,
          headers: {
            Location: location,
            "Preference-Applied": "return=minimal",
          },
        };
      return protocol.entity(
        svc,
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
      const draft = svc.model.entitySets[setName].draft;
      checkIfMatch(svc.model, setName, row, headers, svc.etags, !draft);
      const updated = update(
        svc,
        setName,
        type,
        svc.keyOf(type, row),
        draft ? svc.drafts.beforeUpdate(type, row, body) : body,
        method === "PUT",
        !!draft,
      );
      renewETag(svc.model, setName, type, updated);
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
