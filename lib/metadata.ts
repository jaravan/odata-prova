// Reads a metadata.xml, V2 or V4, into the Model (see model.ts): its types, operations and
// annotations. navigations.ts resolves the navigations, operation-views.ts translates the
// operations for the other protocol, and emit-v2.ts and emit-v4.ts write the Model out as
// the other protocol's $metadata.

import { XMLParser, XMLValidator } from "fast-xml-parser";
import type {
  ComplexType,
  Container,
  EntityType,
  Model,
  NavigationProperty,
  Operation,
  Property,
  TypedElement,
} from "./model.ts";
import { V2_TO_CANONICAL, CANONICAL_TO_V2 } from "./types.ts";
import { parseConcurrency } from "./etag.ts";
import { parseCustomAggregates } from "./aggregates.ts";
import { parseHierarchies } from "./hierarchy.ts";
import { inlineAnnotations } from "./annotations-v2.ts";
import { parseDraftAnnotations, resolveDraftNavigations } from "./draft.ts";
import {
  resolveNavigationsV2,
  resolveNavigationsV4,
  resolvePartners,
} from "./navigations.ts";
import type { JoinMode } from "./navigations.ts";
import { v2ViewOfV2, v4ViewOfV2, v2ViewOfV4 } from "./operation-views.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  // Every element that can repeat is forced into an array so callers never special-case
  // the one-child situation. Elements only: EntitySet has an attribute that is also
  // called EntityType.
  isArray: (name, jpath, isLeaf, isAttribute) =>
    !isAttribute &&
    [
      "Schema",
      "EntityType",
      "Property",
      "PropertyRef",
      "NavigationProperty",
      "Association",
      "End",
      "EntitySet",
      "AssociationSet",
      "EntityContainer",
      "ReferentialConstraint",
      "Key",
      "ComplexType",
      "EnumType",
      "Member",
      "NavigationPropertyBinding",
      "Annotation",
      "Action",
      "Function",
      "ActionImport",
      "FunctionImport",
      "Parameter",
      "Singleton",
      "TypeDefinition",
    ].includes(name),
});

// The parsed XML: elements and attributes by name, repeating elements as arrays (see
// isArray above). Untyped: the parser below reads what it needs and builds the typed Model.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Xml = any;

// Resolves a term's vocabulary alias (see termQualifier)
export type Qualify = (name: string) => string;

// --- Parsing ------------------------------------------------------------------------------

// joins: how a navigation without a ReferentialConstraint is joined (see navigations.ts)
function parseMetadata(
  xml: string,
  { joins = "guess" }: { joins?: JoinMode } = {},
): Model {
  // removeNSPrefix would turn sap:label into label; keep the SAP attributes recognisable.
  // The parser reads what it can; where it can't, its own message doesn't say where.
  let doc: Xml;
  try {
    doc = parser.parse(xml.replace(/(\s)sap:([A-Za-z-]+=)/g, "$1sap__$2"));
  } catch (e) {
    const valid = XMLValidator.validate(xml);
    throw new Error(
      valid === true
        ? `metadata.xml can't be read: ${(e as Error).message}`
        : `metadata.xml isn't well-formed XML, line ${valid.err.line}: ${valid.err.msg}`,
      { cause: e },
    );
  }
  const edmx: Xml = doc.Edmx;
  if (!edmx) throw new Error("metadata.xml: no <edmx:Edmx> root element");
  const schemas: Xml[] = edmx.DataServices?.Schema;
  if (!schemas)
    throw new Error("metadata.xml: no <edmx:DataServices><Schema> found");
  const isV4 = String(edmx.Version || "").startsWith("4");
  resolveTypeNames(schemas);
  checkAttributes(schemas, isV4);

  // Collected first; the model is put together once there is a container
  const entityTypes: Model["entityTypes"] = {};
  const complexTypes: Model["complexTypes"] = {};
  const enumTypes: Model["enumTypes"] = {};
  const entitySets: Model["entitySets"] = {};
  const associations: Model["associations"] = {};
  const associationSets: Model["associationSets"] = [];
  let container: Container | undefined;
  const singletons: string[] = [];

  for (const schema of schemas) {
    const ns = schema.Namespace;

    for (const et of schema.EntityType || []) {
      const fullName = `${ns}.${et.Name}`;
      const properties: Record<string, Property> = {};
      for (const p of et.Property || [])
        properties[p.Name] = normalizeProperty(p, isV4);
      entityTypes[fullName] = {
        name: et.Name,
        fullName,
        namespace: ns,
        baseType: et.BaseType,
        openType: et.OpenType === "true",
        keys: (et.Key?.[0]?.PropertyRef || []).map((k: Xml) => k.Name),
        properties,
        navigationProperties: (et.NavigationProperty || []).map(
          (n: Xml): NavigationProperty =>
            isV4
              ? {
                  name: n.Name,
                  type: n.Type,
                  partner: n.Partner,
                  containsTarget: n.ContainsTarget === "true",
                  onDeleteCascade: n.OnDelete?.Action === "Cascade",
                  constraints: (n.ReferentialConstraint || []).map(
                    (c: Xml) => ({
                      property: c.Property,
                      referencedProperty: c.ReferencedProperty,
                    }),
                  ),
                }
              : {
                  name: n.Name,
                  relationship: n.Relationship,
                  fromRole: n.FromRole,
                  toRole: n.ToRole,
                },
        ),
        // Resolved after inheritance (see navigations.ts)
        navigations: {},
        sap: sapAttributes(et),
      };
    }

    for (const ct of schema.ComplexType || []) {
      const fullName = `${ns}.${ct.Name}`;
      const properties: Record<string, Property> = {};
      for (const p of ct.Property || [])
        properties[p.Name] = normalizeProperty(p, isV4);
      complexTypes[fullName] = {
        name: ct.Name,
        fullName,
        namespace: ns,
        baseType: ct.BaseType,
        openType: ct.OpenType === "true",
        properties,
      };
    }

    for (const en of schema.EnumType || []) {
      const fullName = `${ns}.${en.Name}`;
      enumTypes[fullName] = {
        name: en.Name,
        fullName,
        namespace: ns,
        underlyingType: en.UnderlyingType,
        isFlags: en.IsFlags === "true",
        members: (en.Member || []).map((m: Xml) => ({
          name: m.Name,
          value: m.Value,
        })),
      };
    }

    for (const assoc of schema.Association || []) {
      const fullName = `${ns}.${assoc.Name}`;
      const constraint = assoc.ReferentialConstraint?.[0];
      associations[fullName] = {
        name: assoc.Name,
        fullName,
        ends: (assoc.End || []).map((e: Xml) => ({
          role: e.Role,
          type: e.Type,
          multiplicity: e.Multiplicity,
        })),
        referentialConstraint: constraint
          ? {
              principal: {
                role: constraint.Principal.Role,
                properties: (constraint.Principal.PropertyRef || []).map(
                  (p: Xml) => p.Name,
                ),
              },
              dependent: {
                role: constraint.Dependent.Role,
                properties: (constraint.Dependent.PropertyRef || []).map(
                  (p: Xml) => p.Name,
                ),
              },
            }
          : undefined,
      };
    }

    for (const c of schema.EntityContainer || []) {
      container ||= { name: c.Name, namespace: ns };
      for (const es of c.EntitySet || []) {
        entitySets[es.Name] = {
          name: es.Name,
          entityType: es.EntityType,
          bindings: (es.NavigationPropertyBinding || []).map((b: Xml) => ({
            path: b.Path,
            target: b.Target,
          })),
          unlisted: es.IncludeInServiceDocument === "false" || undefined,
          sap: sapAttributes(es),
        };
      }
      for (const single of c.Singleton || []) singletons.push(single.Name);
      for (const as of c.AssociationSet || []) {
        associationSets.push({
          name: as.Name,
          association: as.Association,
          ends: (as.End || []).map((e: Xml) => ({
            role: e.Role,
            entitySet: e.EntitySet,
          })),
        });
      }
    }
  }
  if (!container) throw new Error("metadata.xml: no <EntityContainer> found");

  const model: Model = {
    sourceVersion: isV4 ? "4.0" : "2.0",
    // Parts of the metadata the server skipped (see disableOnError in navigations.ts),
    // logged at startup
    warnings: singletons.map(
      (name) => `not served: Singleton ${name} (singletons aren't supported)`,
    ),
    singletons,
    entityTypes,
    complexTypes,
    enumTypes,
    entitySets,
    container,
    associations,
    associationSets,
    // Actions and functions (V4) and function imports (V2), see parseOperations
    operations: { bound: [], imports: {} },
    // Operations per protocol, translated for the one the metadata wasn't written in; set
    // below, once the operations are resolved
    operationViews: {
      "2.0": { bound: [], imports: {} },
      "4.0": { bound: [], imports: {} },
    },
    referencesXml: extractBlocks(xml, "edmx:Reference"),
    annotationsXml: [
      ...extractBlocks(xml, "Annotations"),
      ...inlineAnnotations(xml),
    ],
    aliases: parseAliases(edmx, schemas),
    // Filled in as the navigations are resolved (see linkSet in navigations.ts)
    linkSets: {},
  };

  const qualify = termQualifier(model.aliases);
  // Before flattenInheritance: derived types share them
  parseComputed(model, schemas, qualify);
  parseMeasures(model, schemas, qualify);

  parseOperations(model, schemas, isV4);
  flattenInheritance(model.complexTypes, "ComplexType");
  flattenInheritance(model.entityTypes, "EntityType");
  resolvePropertyTypes(model);
  // Inherited keys included: a key names a property, of a type a key can have
  for (const type of Object.values(model.entityTypes))
    for (const k of type.keys) {
      const p = type.properties[k];
      if (!p)
        throw new Error(
          `metadata.xml: EntityType ${type.name}: its key ${k} isn't one of its properties`,
        );
      if (
        p.isCollection ||
        p.complexType ||
        (!p.enumType &&
          !/^Edm\.(Binary|Boolean|Byte|Date|DateTimeOffset|Decimal|Double|Duration|Guid|Int16|Int32|Int64|SByte|Single|String|TimeOfDay)$/.test(
            p.type,
          ))
      )
        throw new Error(
          `metadata.xml: EntityType ${type.name}: its key ${k} is ${p.isCollection ? "a collection" : p.complexType ? "a complex type" : p.type}, which a key can't be`,
        );
    }
  resolveOperationTypes(model);
  model.operationViews = {
    "2.0": isV4 ? v2ViewOfV4(model) : v2ViewOfV2(model),
    "4.0": isV4 ? model.operations : v4ViewOfV2(model),
  };

  for (const es of Object.values(model.entitySets)) {
    if (!model.entityTypes[es.entityType])
      throw new Error(
        `EntitySet ${es.name}: unknown entity type ${es.entityType}`,
      );
    if (!model.entityTypes[es.entityType].keys.length)
      throw new Error(
        `metadata.xml: EntitySet ${es.name}: its type ${model.entityTypes[es.entityType].name} has no Key`,
      );
  }

  parseDraftAnnotations(model, schemas, qualify);
  parseConcurrency(model, schemas, qualify);
  parseCustomAggregates(model, schemas, qualify);
  parseHierarchies(model, schemas, qualify);
  if (isV4) resolveNavigationsV4(model, joins);
  else resolveNavigationsV2(model, joins);
  resolvePartners(model);
  resolveDraftNavigations(model);
  return model;
}

const list = (x: Xml): Xml[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];

// Throws, naming the element, when one lacks an attribute the model can't do without: a
// Property its Type, a navigation its target, a key its property's name
function checkAttributes(schemas: Xml[], isV4: boolean): void {
  const need = (el: Xml, attributes: string[], what: string) => {
    for (const a of attributes)
      if (typeof el?.[a] !== "string" || !el[a])
        throw new Error(`metadata.xml: ${what} has no ${a}`);
  };
  const named = (kind: string, el: Xml) =>
    typeof el?.Name === "string" && el.Name
      ? `${kind} ${el.Name}`
      : `a ${kind}`;
  const params = (op: Xml, where: string) => {
    for (const p of list(op.Parameter))
      need(p, ["Name", "Type"], `${where}: ${named("Parameter", p)}`);
  };
  for (const schema of schemas) {
    need(schema, ["Namespace"], "a Schema");
    for (const kind of ["EntityType", "ComplexType"]) {
      for (const t of list(schema[kind])) {
        need(t, ["Name"], `a ${kind} of ${schema.Namespace}`);
        const where = `${kind} ${t.Name}`;
        for (const p of list(t.Property))
          need(p, ["Name", "Type"], `${where}: ${named("Property", p)}`);
        // A / goes between a property and its member, a navigation and the next
        for (const p of [...list(t.Property), ...list(t.NavigationProperty)])
          if (String(p.Name).includes("/"))
            throw new Error(
              `metadata.xml: ${where}: ${p.Name} isn't a name: a name has no /`,
            );
        for (const n of list(t.NavigationProperty))
          need(
            n,
            isV4
              ? ["Name", "Type"]
              : ["Name", "Relationship", "FromRole", "ToRole"],
            `${where}: ${named("NavigationProperty", n)}`,
          );
        for (const n of list(t.NavigationProperty))
          for (const c of list(n.ReferentialConstraint))
            need(
              c,
              ["Property", "ReferencedProperty"],
              `${where}: NavigationProperty ${n.Name}: a ReferentialConstraint`,
            );
        for (const k of list(t.Key).flatMap((key) => list(key.PropertyRef)))
          need(k, ["Name"], `${where}: a key's PropertyRef`);
      }
    }
    for (const t of list(schema.EnumType)) {
      need(t, ["Name"], `an EnumType of ${schema.Namespace}`);
      for (const m of list(t.Member))
        need(m, ["Name"], `EnumType ${t.Name}: a Member`);
    }
    for (const a of list(schema.Association)) {
      need(a, ["Name"], `an Association of ${schema.Namespace}`);
      const ends = list(a.End);
      if (ends.length !== 2)
        throw new Error(
          `metadata.xml: Association ${a.Name} has ${ends.length} Ends, not 2`,
        );
      for (const e of ends)
        need(e, ["Role", "Type"], `Association ${a.Name}: an End`);
      for (const side of ["Principal", "Dependent"]) {
        const c = list(a.ReferentialConstraint)[0];
        if (!c) continue;
        const what = `Association ${a.Name}: its ReferentialConstraint's ${side}`;
        need(c[side], ["Role"], what);
        for (const ref of list(c[side].PropertyRef))
          need(ref, ["Name"], `${what}: a PropertyRef`);
      }
    }
    for (const kind of ["Action", "Function"])
      for (const o of list(schema[kind])) {
        need(o, ["Name"], `an ${kind} of ${schema.Namespace}`);
        params(o, `${kind} ${o.Name}`);
      }
    for (const c of list(schema.EntityContainer)) {
      for (const es of list(c.EntitySet))
        need(es, ["Name", "EntityType"], named("EntitySet", es));
      for (const as of list(c.AssociationSet)) {
        need(as, ["Name", "Association"], named("AssociationSet", as));
        for (const e of list(as.End))
          need(e, ["Role", "EntitySet"], `AssociationSet ${as.Name}: an End`);
      }
      for (const fi of list(c.FunctionImport)) {
        need(
          fi,
          isV4 ? ["Name", "Function"] : ["Name"],
          named("FunctionImport", fi),
        );
        params(fi, `FunctionImport ${fi.Name}`);
      }
      for (const ai of list(c.ActionImport))
        need(ai, ["Name", "Action"], named("ActionImport", ai));
    }
  }
}

// The namespace of each alias in the document's <edmx:Include Alias> and <Schema Alias>
function parseAliases(edmx: Xml, schemas: Xml[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const ref of list(edmx.Reference))
    for (const inc of list(ref.Include))
      if (inc.Alias) aliases[inc.Alias] = inc.Namespace;
  for (const schema of schemas)
    if (schema.Alias) aliases[schema.Alias] = schema.Namespace;
  return aliases;
}

// A function that resolves a term's alias to its namespace:
// "Common.DraftRoot" -> "com.sap.vocabularies.Common.v1.DraftRoot"
function termQualifier(aliases: Record<string, string>): Qualify {
  return (name) => {
    if (!name) return name;
    const dot = name.lastIndexOf(".");
    const prefix = name.slice(0, dot);
    return `${aliases[prefix] || prefix}${name.slice(dot)}`;
  };
}

// Core.Computed on an entity type's property, inline or in an <Annotations> block targeting
// it ("Ns.Type/Prop"), sets p.computed: the service fills the value in, so a write doesn't
// need to carry it. V2 documents can carry these V4 annotations too.
function parseComputed(model: Model, schemas: Xml[], qualify: Qualify): void {
  const computed = (annotations: Xml) =>
    list(annotations).some(
      (a: Xml) =>
        !a.Qualifier &&
        qualify(a.Term) === "Org.OData.Core.V1.Computed" &&
        a.Bool !== "false",
    );
  for (const schema of schemas) {
    for (const et of schema.EntityType || [])
      for (const p of et.Property || [])
        if (computed(p.Annotation))
          model.entityTypes[`${schema.Namespace}.${et.Name}`].properties[
            p.Name
          ].computed = true;
    for (const block of list(schema.Annotations)) {
      const [typeName, propName, ...rest] = String(block.Target).split("/");
      const p = model.entityTypes[qualify(typeName)]?.properties[propName];
      if (p && !rest.length && computed(block.Annotation)) p.computed = true;
    }
  }
}

// Which property holds an amount's currency or a quantity's unit, into p.measure: V4's
// Measures.ISOCurrency and Measures.Unit with a Path (inline, or in an <Annotations> block
// targeting "Ns.Type/Prop"), and V2's sap:unit, which names the property either way: it's a
// currency when that property says so (sap:semantics="currency-code") or is named like one.
// The mock data generator reads them (see generate.ts).
function parseMeasures(model: Model, schemas: Xml[], qualify: Qualify): void {
  const TERMS: Record<string, "currency" | "unit"> = {
    "Org.OData.Measures.V1.ISOCurrency": "currency",
    "Org.OData.Measures.V1.Unit": "unit",
  };
  const read = (p: Property | undefined, annotations: Xml) => {
    for (const a of list(annotations)) {
      const kind = TERMS[qualify(a.Term)];
      // A Path, as an attribute or an element; a String (a fixed currency) names no property
      if (p && kind && !a.Qualifier && typeof a.Path === "string")
        (p.measure ??= {})[kind] = a.Path;
    }
  };
  const types = { ...model.entityTypes, ...model.complexTypes };
  for (const schema of schemas) {
    for (const t of [
      ...(schema.EntityType || []),
      ...(schema.ComplexType || []),
    ])
      for (const p of t.Property || [])
        read(
          types[`${schema.Namespace}.${t.Name}`]?.properties[p.Name],
          p.Annotation,
        );
    for (const block of list(schema.Annotations)) {
      const [typeName, propName, ...rest] = String(block.Target).split("/");
      if (!rest.length)
        read(types[qualify(typeName)]?.properties[propName], block.Annotation);
    }
  }
  for (const t of Object.values(types))
    for (const p of Object.values(t.properties)) {
      const target = p.sap.unit && t.properties[p.sap.unit];
      if (!target || p.measure) continue;
      const currency =
        target.sap.semantics === "currency-code" ||
        (target.sap.semantics !== "unit-of-measure" &&
          /currency|waers|curr|cuky/i.test(target.name));
      p.measure = { [currency ? "currency" : "unit"]: target.name };
    }
}

// The attributes that name a type, an association, an action or a function
const TYPE_ATTRIBUTES = [
  "Type",
  "BaseType",
  "EntityType",
  "ReturnType",
  "UnderlyingType",
  "Relationship",
  "Association",
  "Action",
  "Function",
  "sap__action-for",
];
// The facets a TypeDefinition passes on to the elements of its type that don't set their own
const FACETS = ["MaxLength", "Precision", "Scale", "SRID", "Unicode"];

// Type references by their namespace, on the parsed document before anything reads one:
//   - a schema's alias replaced (T.Order is a.types.Order, as CAP's SAP__self.Order is)
//   - a TypeDefinition replaced by its underlying type (T.Amount is Edm.Decimal), with its
//     facets where the element has none of its own: the model, and the V2 metadata, which
//     has no TypeDefinition, know only Edm types
function resolveTypeNames(schemas: Xml[]): void {
  const aliases = new Map<string, string>(
    schemas
      .filter((s) => s.Alias)
      .map((s): [string, string] => [s.Alias, s.Namespace]),
  );
  const qualified = (name: string) =>
    name.replace(
      /^(Collection\()?([^.()]+)\.(?=[^()]+\)?$)/,
      (all, collection = "", prefix: string) =>
        aliases.has(prefix) ? `${collection}${aliases.get(prefix)}.` : all,
    );
  const definitions = new Map<string, Xml>();
  for (const schema of schemas)
    for (const td of schema.TypeDefinition || [])
      definitions.set(`${schema.Namespace}.${td.Name}`, td);

  const visit = (node: Xml): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const attr of TYPE_ATTRIBUTES)
      if (typeof node[attr] === "string") node[attr] = qualified(node[attr]);
    if (typeof node.Type === "string") {
      const m = node.Type.match(/^(Collection\()?(.+?)(\))?$/);
      const td = definitions.get(m[2]);
      if (td) {
        node.Type = `${m[1] ?? ""}${qualified(td.UnderlyingType)}${m[3] ?? ""}`;
        for (const facet of FACETS)
          if (node[facet] === undefined && td[facet] !== undefined)
            node[facet] = td[facet];
      }
    }
    for (const [key, child] of Object.entries(node))
      if (key !== "Annotation" && key !== "Annotations") visit(child);
  };
  visit(schemas);
}

// A derived type (BaseType) gets its base's key, properties and navigations copied in, so
// every type stands on its own and the generated $metadata needs no BaseType.
// Entity and complex types alike; only entity types have keys and navigation properties
type Structured = ComplexType &
  Partial<Pick<EntityType, "keys" | "navigationProperties">>;

function flattenInheritance(
  types: Record<string, Structured>,
  kind: string,
): void {
  const done = new Set<string>();
  const flatten = (type: Structured, seen: Set<string>) => {
    if (!type.baseType || done.has(type.fullName)) return;
    if (seen.has(type.fullName))
      throw new Error(`${kind} ${type.fullName}: BaseType cycle`);
    seen.add(type.fullName);
    const base = types[type.baseType];
    if (!base)
      throw new Error(
        `${kind} ${type.fullName}: unknown BaseType ${type.baseType}`,
      );
    flatten(base, seen);
    type.properties = { ...base.properties, ...type.properties };
    // A type derived from an open type is open too
    if (base.openType) type.openType = true;
    // An entity type's base is an entity type, so it has both
    if (type.keys && type.keys.length === 0) type.keys = [...base.keys!];
    if (type.navigationProperties)
      type.navigationProperties = [
        ...base.navigationProperties!,
        ...type.navigationProperties,
      ];
    done.add(type.fullName);
  };
  for (const type of Object.values(types)) flatten(type, new Set());
}

// Each property points at its complex or enum type, so values can be converted and emitted.
// V2 has no collection-valued properties: those are left out of the V2 service.
function resolvePropertyTypes(model: Model): void {
  const types = [
    ...Object.values(model.entityTypes),
    ...Object.values(model.complexTypes),
  ];
  const done = new Set<Property>(); // inherited properties are shared with the base type
  for (const type of types) {
    for (const p of Object.values(type.properties)) {
      if (done.has(p)) continue;
      done.add(p);
      resolveTypeRef(model, p);
      if (p.isCollection) {
        p.v2Omit = true;
        model.warnings.push(
          `not in V2: ${type.name}.${p.name} is a collection-valued property`,
        );
      }
    }
  }
}

// Sets isCollection, elementType, complexType and enumType on a property, parameter or return type
function resolveTypeRef(model: Model, p: Property): void {
  const m = p.type.match(/^Collection\((.+)\)$/);
  p.isCollection = !!m;
  p.elementType = m ? m[1] : p.type;
  p.complexType = model.complexTypes[p.elementType];
  p.enumType = model.enumTypes[p.elementType];
  if (p.enumType) p.v2Type = "Edm.String"; // V2 has no enums: the member name
}

// Operations, the same shape for both protocols:
//   { name, fullName, kind: "action" | "function", isBound, binding, parameters, returnType,
//     entitySet, httpMethod, actionFor }
// binding, parameters and returnType are shaped like properties (normalizeProperty).
// V4: bound operations go to operations.bound, imports (by import name) to operations.imports.
// V2 has only function imports; m:HttpMethod POST makes one an action, GET a function.
function parseOperations(model: Model, schemas: Xml[], isV4: boolean): void {
  const typeRef = (name: string, type: string | undefined) =>
    type ? normalizeProperty({ Name: name, Type: type }, isV4) : undefined;
  const unbound: Record<string, Operation> = {};
  for (const schema of schemas) {
    const ns = schema.Namespace;
    if (isV4) {
      for (const kind of ["Action", "Function"] as const) {
        for (const o of schema[kind] || []) {
          const params: TypedElement[] = (o.Parameter || []).map((p: Xml) =>
            normalizeProperty(p, true),
          );
          const isBound = o.IsBound === "true";
          if (isBound && params.length === 0) {
            model.warnings.push(
              `operation disabled: ${kind} ${o.Name} is bound but has no binding parameter`,
            );
            continue;
          }
          const op: Operation = {
            name: o.Name,
            fullName: `${ns}.${o.Name}`,
            kind: kind === "Action" ? "action" : "function",
            isBound,
            binding: isBound ? params[0] : undefined,
            parameters: isBound ? params.slice(1) : params,
            returnType: typeRef("", o.ReturnType?.Type),
          };
          if (isBound) model.operations.bound.push(op);
          else unbound[op.fullName] ||= op; // an overload keeps the first
        }
      }
    }
    for (const container of schema.EntityContainer || []) {
      if (isV4) {
        for (const [tag, attr] of [
          ["ActionImport", "Action"],
          ["FunctionImport", "Function"],
        ]) {
          for (const imp of container[tag] || []) {
            const op = unbound[imp[attr]];
            if (!op) {
              model.warnings.push(
                `operation disabled: ${tag} ${
                  imp.Name
                }: unknown ${attr.toLowerCase()} ${imp[attr]}`,
              );
              continue;
            }
            model.operations.imports[imp.Name] = {
              ...op,
              name: imp.Name,
              entitySet: imp.EntitySet,
            };
          }
        }
        continue;
      }
      for (const fi of container.FunctionImport || []) {
        const httpMethod = String(fi.HttpMethod || "GET").toUpperCase();
        model.operations.imports[fi.Name] = {
          name: fi.Name,
          fullName: `${ns}.${fi.Name}`,
          kind: httpMethod === "GET" ? "function" : "action",
          isBound: false,
          parameters: (fi.Parameter || []).map((p: Xml) =>
            normalizeProperty(p, false),
          ),
          returnType: typeRef("", fi.ReturnType),
          entitySet: fi.EntitySet,
          httpMethod,
          // sap:action-for: the entity type the import acts on
          actionFor: fi["sap__action-for"],
        };
      }
    }
  }
}

function resolveOperationTypes(model: Model): void {
  const ops = [
    ...model.operations.bound,
    ...Object.values(model.operations.imports),
  ];
  for (const op of ops) {
    for (const p of [op.binding, ...op.parameters, op.returnType]) {
      if (!p) continue;
      resolveTypeRef(model, p);
      p.entityType = model.entityTypes[p.elementType];
    }
  }
}

// An element's sap: attributes, without the prefix (see parseMetadata)
function sapAttributes(el: Xml): Record<string, string> {
  const sap: Record<string, string> = {};
  for (const [k, v] of Object.entries<string>(el))
    if (k.startsWith("sap__")) sap[k.slice(5)] = v;
  return sap;
}

// isCollection and elementType are set again by resolveTypeRef, once all types are known
function normalizeProperty(p: Xml, isV4: boolean): TypedElement {
  const sap = sapAttributes(p);
  let type: string = p.Type,
    v2Type: string;
  if (isV4) {
    v2Type = CANONICAL_TO_V2[type] || type;
  } else {
    v2Type = type;
    type = V2_TO_CANONICAL[type] || type;
    if (v2Type === "Edm.DateTime" && sap["display-format"] === "Date")
      type = "Edm.Date";
  }
  return {
    name: p.Name,
    type,
    v2Type,
    nullable: p.Nullable !== "false",
    maxLength: p.MaxLength,
    precision: p.Precision,
    scale: p.Scale,
    label: sap.label,
    sap,
    isCollection: false,
    elementType: type,
    concurrency: p.ConcurrencyMode === "Fixed" || undefined,
  };
}

// Raw "<Tag ...>...</Tag>" (or self-closing) blocks, kept verbatim for re-emission.
function extractBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(
    `<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`,
    "g",
  );
  return xml.match(re) || [];
}

export { parseMetadata };
