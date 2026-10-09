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
  // Kept verbatim for the generated metadata of the other protocol
  referencesXml: string[];
  annotationsXml: string[];
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
  // Inherited ones included (see flattenInheritance)
  keys: string[];
  properties: Record<string, Property>;
  // As declared, before they are resolved into navigations
  navigationProperties: NavigationProperty[];
  navigations: Record<string, Navigation>;
  // Declared navigations the server can't join, with the reason (requests using one get a 501)
  disabledNavigations?: Record<string, string>;
  // SiblingEntity and DraftAdministrativeData of a draft-enabled type (see draft.js)
  draftNavigations?: Record<string, DraftNavigation>;
}

export interface ComplexType {
  name: string;
  fullName: string;
  namespace: string;
  baseType?: string;
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
  // A collection-valued property, which V2 has no place for
  v2Omit?: boolean;
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
  // A composition between draft-enabled sets, which also joins on IsActiveEntity
  draft?: "composition";
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
}

// From the request's headers
export interface ResponseOptions {
  // Accept: ...;IEEE754Compatible=true: Int64 and Decimal as strings
  ieee754: boolean;
  prefer: string;
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
