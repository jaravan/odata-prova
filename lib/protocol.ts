// What a protocol module supplies (protocols/v2.ts and v4.ts) and what the service hands it:
// how literals are read and keys written, and what each kind of response looks like.

import type { LiteralSyntax } from "./filter.ts";
import type { Removed } from "./delta.ts";
import type { ODataService } from "./service.ts";
import type {
  EntityType,
  ODataResponse,
  ODataVersion,
  Operation,
  Property,
  PropertyValue,
  QueryNode,
  ResponseOptions,
  Row,
  TypedElement,
} from "./model.ts";

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
  // The query option of a delta link: V4's $deltatoken=..., SAP's V2 !deltatoken='...'
  deltaOption?(token: string): Record<string, string>;
  // What changed in an entity set since a delta token (see delta.ts)
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

// The request headers dispatch reads (accept, prefer)
export type RequestHeaders = Record<string, string | string[] | undefined>;
