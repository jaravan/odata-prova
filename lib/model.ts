// The shapes the server works with: the model parseMetadata builds from a metadata.xml
// (V2 or V4, normalized to one form), the rows of the store, and a request's query options
// and response. Types only, nothing here exists at run time.

export type ODataVersion = "2.0" | "4.0";

// --- Model ---------------------------------------------------------------------------------

export interface Model {
  sourceVersion: ODataVersion;
  // Parts of the metadata the server skipped (see disableOnError), logged at startup
  warnings: string[];
  // All keyed by qualified name ("Namespace.Name"), entity sets by name
  entityTypes: Record<string, EntityType>;
  complexTypes: Record<string, ComplexType>;
  enumTypes: Record<string, EnumType>;
  entitySets: Record<string, EntitySet>;
  container: Container;
  // V2 only: the associations navigations are resolved from
  associations: Record<string, Association>;
  associationSets: AssociationSet[];
  // As the metadata declares them, and as each protocol serves them (see operationViews)
  operations: OperationView;
  operationViews: Record<ODataVersion, OperationView>;
  // Kept verbatim for the generated metadata of the other protocol; annotationsXml also has
  // a block for each element with inline annotations (see inlineAnnotations)
  referencesXml: string[];
  annotationsXml: string[];
  // The namespace each alias stands for, from <edmx:Include Alias> and <Schema Alias>
  aliases: Record<string, string>;
  // The link sets of the navigations no key can join, many-to-many ones (see linkSet in
  // navigations.ts), by name
  linkSets: Record<string, LinkSet>;
}

// Pairs of keys that link two entity sets' rows, which the store keeps as rows of their own,
// under the name: People-Friends, with columns UserName and Friends_UserName
export interface LinkSet {
  name: string;
  ends: [LinkEnd, LinkEnd];
}

// One side of a link set: the entity set, its type's keys, and the columns holding them
export interface LinkEnd {
  set: string;
  keys: string[];
  columns: string[];
}

export interface Container {
  name: string;
  namespace: string;
}

export interface EntityType {
  name: string;
  fullName: string;
  namespace: string;
  baseType?: string;
  // OpenType="true": properties the metadata doesn't declare are allowed too
  openType?: boolean;
  // Inherited ones included (see flattenInheritance)
  keys: string[];
  properties: Record<string, Property>;
  // As declared, before they are resolved into navigations
  navigationProperties: NavigationProperty[];
  navigations: Record<string, Navigation>;
  // Declared navigations the server can't join, with the reason (requests using one get a 501)
  disabledNavigations?: Record<string, string>;
  // Foreign keys the metadata doesn't have, which the server keeps for a single-valued
  // navigation without one (Photo_Id for Photo, see hiddenKey in navigations.ts): columns of
  // the rows, not properties, so no response or $metadata shows them
  hiddenKeys?: Record<string, Property>;
  // A contained type's hidden keys that hold its parent's keys (Person_UserName for a
  // person's trips), which, with its keys, tell its entities apart (see keyOf in service.ts)
  parentKeys?: string[];
  // SiblingEntity and DraftAdministrativeData of a draft-enabled type (see draft.ts)
  draftNavigations?: Record<string, DraftNavigation>;
  // The sap: attributes of a V2 document, without the prefix (label, ...)
  sap?: Record<string, string>;
  // Aggregation.CustomAggregate, on the type or one of its entity sets: name -> the Edm type
  // of its value (see aggregation.ts)
  customAggregates?: Record<string, string>;
  // Aggregation.RecursiveHierarchy with Hierarchy.RecursiveHierarchy, by qualifier (see
  // hierarchy.ts)
  hierarchies?: Record<string, Hierarchy>;
}

// A recursive hierarchy: the property that identifies a node and the navigation to its
// parent, and the properties a hierarchy's result fills in for each node, when named
export interface Hierarchy {
  nodeProperty: string;
  parentNavigation: string;
  drillState?: string;
  distanceFromRoot?: string;
  limitedDescendantCount?: string;
  limitedRank?: string;
}

export interface ComplexType {
  name: string;
  fullName: string;
  namespace: string;
  baseType?: string;
  // OpenType="true", as for an entity type
  openType?: boolean;
  properties: Record<string, Property>;
}

export interface EnumType {
  name: string;
  fullName: string;
  namespace: string;
  underlyingType?: string;
  isFlags: boolean;
  members: { name: string; value?: string }[];
}

// A property, as normalizeProperty reads it and resolveTypeRef completes it
export interface Property {
  name: string;
  // Canonical (V4) Edm type, or a complex or enum type's qualified name; Collection(...) for
  // a collection
  type: string;
  // The type as V2 spells it (Edm.DateTime, Edm.Time; Edm.String for an enum)
  v2Type: string;
  nullable: boolean;
  maxLength?: string;
  precision?: string;
  scale?: string;
  label?: string;
  // The sap: attributes of a V2 document, without the prefix (creatable, updatable, label, ...)
  sap: Record<string, string>;
  isCollection: boolean;
  // type without Collection(...)
  elementType: string;
  complexType?: ComplexType;
  enumType?: EnumType;
  // Core.Computed: the service fills the value in
  computed?: boolean;
  // ConcurrencyMode="Fixed" (V2): part of the entity's ETag (see etag.ts)
  concurrency?: boolean;
  // A collection-valued property, which V2 has no place for
  v2Omit?: boolean;
  // A path's property in $apply (Items/Material): the indexes of its segments that are
  // collection navigations (see withPaths in aggregation.ts)
  collectionSegments?: number[];
}

// A parameter, binding parameter or return type of an operation: a property that can also be
// of an entity type
export interface TypedElement extends Property {
  entityType?: EntityType;
}

// --- Navigation ----------------------------------------------------------------------------

export type NavigationProperty = V4NavigationProperty | V2NavigationProperty;

export interface V4NavigationProperty {
  name: string;
  type: string;
  partner?: string;
  containsTarget: boolean;
  onDeleteCascade: boolean;
  constraints: { property: string; referencedProperty: string }[];
  isCollection?: boolean;
}

export interface V2NavigationProperty {
  name: string;
  relationship: string;
  fromRole: string;
  toRole: string;
  isCollection?: boolean;
}

// [source property, target property]
export type JoinPair = [string, string];

// A navigation property resolved to the entity set it leads to and how rows join
export interface Navigation {
  name: string;
  targetSet: string;
  targetType: string;
  isCollection: boolean;
  // Which side holds the foreign key
  dependentSide: "source" | "target";
  join: JoinPair[];
  cascadeDelete: boolean;
  partner?: string;
  // Into a draft-enabled set (see resolveDraftNavigations): "composition" from parent to
  // children inside a draft tree (also joined on IsActiveEntity), "active" from outside the
  // tree (reaches the active entities only)
  draft?: "composition" | "active";
  // Joined on hidden key columns (see hiddenKeys), or through a link set (links), which no
  // $metadata has a constraint for
  hidden?: boolean;
  // Joined through a link set (see LinkSet), with no join pairs: its name, and which of its
  // ends is this navigation's source
  links?: { set: string; from: 0 | 1 };
  // A containment navigation into a contained entity set (see EntitySet), which V2 has no
  // place for
  contained?: boolean;
}

// SiblingEntity or DraftAdministrativeData, which the metadata gives no join for
export interface DraftNavigation {
  name: string;
  draft: "sibling" | "admin";
  targetSet: string;
  targetType: string;
  isCollection: false;
  join: JoinPair[];
}

export type AnyNavigation = Navigation | DraftNavigation;

// --- Entity sets ---------------------------------------------------------------------------

export interface EntitySet {
  name: string;
  // Qualified name of the entity type
  entityType: string;
  // V4 NavigationPropertyBinding
  bindings: { path: string; target: string }[];
  draft?: DraftInfo;
  // The sap: attributes of a V2 document, without the prefix (creatable, searchable, ...)
  sap?: Record<string, string>;
  // The properties its entities' ETag is made of, when it has one (see etag.ts)
  concurrency?: string[];
  // An entity set of the server's own, for the targets of a containment navigation (see
  // resolveContainment in navigations.ts): its parent's entity set and the navigation. It's
  // in no service document or $metadata, and reached only through the navigation.
  contained?: { parentSet: string; navigation: string };
}

// Common.DraftRoot / DraftNode (see parseDraftAnnotations): the actions are qualified names,
// or function import paths in a V2 document
export interface DraftInfo {
  root: boolean;
  actions: {
    activate?: string;
    edit?: string;
    prepare?: string;
    new?: string;
  };
}

// --- V2 associations -----------------------------------------------------------------------

export interface Association {
  name: string;
  fullName: string;
  ends: { role: string; type: string; multiplicity: "1" | "0..1" | "*" }[];
  referentialConstraint?: {
    principal: { role: string; properties: string[] };
    dependent: { role: string; properties: string[] };
  };
}

export interface AssociationSet {
  name: string;
  association: string;
  ends: { role: string; entitySet: string }[];
}

// --- Operations ----------------------------------------------------------------------------

// A V4 action or function, or a V2 function import
export interface Operation {
  name: string;
  fullName: string;
  kind: "action" | "function";
  isBound: boolean;
  binding?: TypedElement;
  parameters: TypedElement[];
  returnType?: TypedElement;
  // V2 function imports say which method calls them (m:HttpMethod: GET, POST, ...)
  httpMethod?: string;
  // The entity set an import's result comes from
  entitySet?: string;
  // A V2 import that acts on an entity, found by the key parameters (sap:action-for)
  bindsTo?: { type: EntityType; setName: string; isCollection: boolean };
  actionFor?: string;
  // The V4 action or function import a V2 view's import comes from (see v2ViewOfV4)
  importName?: string;
}

export interface OperationView {
  bound: Operation[];
  imports: Record<string, Operation>;
}

// --- Data ----------------------------------------------------------------------------------

// A primitive value in its internal form (see toInternal in types.ts): Int64 and Decimal as
// strings, dates and times as ISO strings
export type PrimitiveValue = string | number | boolean | null;

// A property value: a primitive, a complex value (field by field) or a collection
export type PropertyValue =
  PrimitiveValue | PropertyValue[] | { [name: string]: PropertyValue };

// An entity in the store
export type Row = Record<string, PropertyValue>;

// Key property values of an entity: primitives, but taken from rows and operation
// parameters as well as from URLs
export type Key = Record<string, PropertyValue>;

// --- Requests ------------------------------------------------------------------------------

// The query options of a request, or of one $expand node: the same shape at every level
export interface QueryNode {
  expand: Record<string, QueryNode>;
  // undefined: every property
  select?: Set<string>;
  filter?: string;
  orderby?: string;
  top?: number;
  skip?: number;
  count?: boolean;
  search?: string;
  // V4 $apply, run before the options above (see aggregation.ts)
  apply?: Transformation[];
  // V4 $compute: properties computed for each row (see compute.ts)
  compute?: Computation[];
  // V4: the delta token of a delta link (see delta.ts)
  deltatoken?: string;
  // Where a page of server-driven paging starts, within the rows $skip and $top leave (see
  // paging in service.ts)
  skiptoken?: number;
}

// One of $compute's properties: "NetPrice mul Quantity as LineTotal"
export interface Computation {
  expression: string;
  alias: string;
}

// One step of $apply, e.g. filter(Status eq 'Open')/groupby((Currency),aggregate(...))
export type Transformation =
  | { kind: "filter"; filter: string }
  | { kind: "groupby"; properties: string[]; aggregates: Aggregate[] }
  // groupby((Country),filter($these/aggregate(Amount) gt 1000)) or any other sequence: what
  // the sequence gives for each group's rows, in which $these is the group
  | { kind: "groupseq"; properties: string[]; sequence: Transformation[] }
  | { kind: "aggregate"; aggregates: Aggregate[] }
  | { kind: "search"; search: string }
  | { kind: "orderby"; orderby: string }
  | { kind: "skip" | "top"; count: number }
  // topcount(2,Amount): the rows with the highest or lowest values of a property, path or
  // expression (by), as many as a count, or as add up to a sum or to a percentage of the
  // total
  | {
      kind: "rank";
      method:
        | "topcount"
        | "bottomcount"
        | "topsum"
        | "bottomsum"
        | "toppercent"
        | "bottompercent";
      value: number;
      by: string;
    }
  // compute(Amount mul 2 as Double): a property computed for each row (see compute.ts)
  | { kind: "compute"; compute: Computation[] }
  // traverse($root/Genres,GenresHierarchy,ID,preorder): the rows in the hierarchy's order,
  // a parent before its children (preorder) or after them (postorder), with roots and
  // siblings sorted by orderby when given
  | {
      kind: "traverse";
      set: string;
      qualifier: string;
      nodeProperty: string;
      order: "preorder" | "postorder";
      orderby?: string;
    }
  | { kind: "identity" }
  // com.sap.vocabularies.Hierarchy.v1.TopLevels(...): the first levels of a hierarchy in
  // preorder, with nodes expanded (levels > 0, or null for all) or collapsed (0), and the
  // nodes to show (their ancestors expanded)
  | {
      kind: "toplevels";
      set: string;
      qualifier: string;
      nodeProperty: string;
      levels?: number;
      expandLevels: { nodeId: string; levels: number | null }[];
      show: string[];
    }
  // ancestors(...) and descendants(...): the rows that are ancestors or descendants of those
  // the transformations give (the start nodes), within distance levels, and with the start
  // nodes when keepStart
  | {
      kind: "ancestors" | "descendants";
      set: string;
      qualifier: string;
      nodeProperty: string;
      transformations: Transformation[];
      distance?: number;
      keepStart: boolean;
    }
  // Each sequence runs on the same input, and their results follow one another
  | { kind: "concat"; sequences: Transformation[][] };

// An aggregate expression: "TotalAmount with sum as Total", "$count as Count" (no property),
// or a custom aggregate, "TotalAmount" or "TotalAmount as Total"
export interface Aggregate {
  property?: string;
  method:
    "sum" | "min" | "max" | "average" | "countdistinct" | "count" | "custom";
  alias: string;
}

// From the request's headers
export interface ResponseOptions {
  // Accept: ...;IEEE754Compatible=true: Int64 and Decimal as strings
  ieee754: boolean;
  prefer: string;
  // Server-driven paging, on a GET (see paging in service.ts): the most rows a page holds,
  // and the URL of the page that starts at a $skiptoken
  page?: { size: number; link(skiptoken: number): string };
  // A V4 GET of an entity set that tracks changes (see delta.ts): its delta link, with a new
  // delta token
  deltaLink?(): string;
}

// What a service answers, for Express or for a $batch part
export interface ODataResponse {
  status: number;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

// A literal from a URL or $filter: its value and Edm type (null for the null literal)
export interface Literal {
  value: unknown;
  type: string | null;
}
