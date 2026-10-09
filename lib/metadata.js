const { XMLParser } = require("fast-xml-parser");
const { V2_TO_CANONICAL, CANONICAL_TO_V2 } = require("./types");
const {
  parseDraftAnnotations,
  isDraftNavigation,
  resolveDraftNavigations,
} = require("./draft");

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
    ].includes(name),
});

const NS = {
  v2: {
    edmx: "http://schemas.microsoft.com/ado/2007/06/edmx",
    m: "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata",
    edm: "http://schemas.microsoft.com/ado/2008/09/edm",
    sap: "http://www.sap.com/Protocols/SAPData",
  },
  v4: {
    edmx: "http://docs.oasis-open.org/odata/ns/edmx",
    edm: "http://docs.oasis-open.org/odata/ns/edm",
  },
};

// --- Parsing ------------------------------------------------------------------------------

function parseMetadata(xml) {
  // removeNSPrefix would turn sap:label into label; keep the SAP attributes recognisable.
  const doc = parser.parse(xml.replace(/(\s)sap:([A-Za-z-]+=)/g, "$1sap__$2"));
  const edmx = doc.Edmx;
  if (!edmx) throw new Error("metadata.xml: no <edmx:Edmx> root element");
  const schemas = edmx.DataServices?.Schema;
  if (!schemas)
    throw new Error("metadata.xml: no <edmx:DataServices><Schema> found");
  const isV4 = String(edmx.Version || "").startsWith("4");

  const model = {
    sourceVersion: isV4 ? "4.0" : "2.0",
    // Parts of the metadata the server skipped (see disableOnError), logged at startup
    warnings: [],
    entityTypes: {},
    complexTypes: {},
    enumTypes: {},
    entitySets: {},
    container: undefined,
    associations: {},
    associationSets: [],
    // Actions and functions (V4) and function imports (V2), see parseOperations
    operations: { bound: [], imports: {} },
    // Operations per protocol, translated for the one the metadata wasn't written in:
    // { "2.0": { bound, imports }, "4.0": { bound, imports } }
    operationViews: undefined,
    referencesXml: extractBlocks(xml, "edmx:Reference"),
    annotationsXml: extractBlocks(xml, "Annotations"),
  };

  for (const schema of schemas) {
    const ns = schema.Namespace;

    for (const et of schema.EntityType || []) {
      const fullName = `${ns}.${et.Name}`;
      const properties = {};
      for (const p of et.Property || [])
        properties[p.Name] = normalizeProperty(p, isV4);
      model.entityTypes[fullName] = {
        name: et.Name,
        fullName,
        namespace: ns,
        baseType: et.BaseType,
        keys: (et.Key?.[0]?.PropertyRef || []).map((k) => k.Name),
        properties,
        navigationProperties: (et.NavigationProperty || []).map((n) =>
          isV4
            ? {
                name: n.Name,
                type: n.Type,
                partner: n.Partner,
                containsTarget: n.ContainsTarget === "true",
                onDeleteCascade: n.OnDelete?.Action === "Cascade",
                constraints: (n.ReferentialConstraint || []).map((c) => ({
                  property: c.Property,
                  referencedProperty: c.ReferencedProperty,
                })),
              }
            : {
                name: n.Name,
                relationship: n.Relationship,
                fromRole: n.FromRole,
                toRole: n.ToRole,
              },
        ),
      };
    }

    for (const ct of schema.ComplexType || []) {
      const fullName = `${ns}.${ct.Name}`;
      const properties = {};
      for (const p of ct.Property || [])
        properties[p.Name] = normalizeProperty(p, isV4);
      model.complexTypes[fullName] = {
        name: ct.Name,
        fullName,
        namespace: ns,
        baseType: ct.BaseType,
        properties,
      };
    }

    for (const en of schema.EnumType || []) {
      const fullName = `${ns}.${en.Name}`;
      model.enumTypes[fullName] = {
        name: en.Name,
        fullName,
        namespace: ns,
        underlyingType: en.UnderlyingType,
        isFlags: en.IsFlags === "true",
        members: (en.Member || []).map((m) => ({
          name: m.Name,
          value: m.Value,
        })),
      };
    }

    for (const assoc of schema.Association || []) {
      const fullName = `${ns}.${assoc.Name}`;
      const constraint = assoc.ReferentialConstraint?.[0];
      model.associations[fullName] = {
        name: assoc.Name,
        fullName,
        ends: (assoc.End || []).map((e) => ({
          role: e.Role,
          type: e.Type,
          multiplicity: e.Multiplicity,
        })),
        referentialConstraint: constraint
          ? {
              principal: {
                role: constraint.Principal.Role,
                properties: (constraint.Principal.PropertyRef || []).map(
                  (p) => p.Name,
                ),
              },
              dependent: {
                role: constraint.Dependent.Role,
                properties: (constraint.Dependent.PropertyRef || []).map(
                  (p) => p.Name,
                ),
              },
            }
          : undefined,
      };
    }

    for (const container of schema.EntityContainer || []) {
      model.container ||= { name: container.Name, namespace: ns };
      for (const es of container.EntitySet || []) {
        model.entitySets[es.Name] = {
          name: es.Name,
          entityType: es.EntityType,
          bindings: (es.NavigationPropertyBinding || []).map((b) => ({
            path: b.Path,
            target: b.Target,
          })),
        };
      }
      for (const as of container.AssociationSet || []) {
        model.associationSets.push({
          name: as.Name,
          association: as.Association,
          ends: (as.End || []).map((e) => ({
            role: e.Role,
            entitySet: e.EntitySet,
          })),
        });
      }
    }
  }
  if (!model.container)
    throw new Error("metadata.xml: no <EntityContainer> found");

  const qualify = termQualifier(edmx, schemas);
  parseComputed(model, schemas, qualify); // before flattenInheritance: derived types share it

  parseOperations(model, schemas, isV4);
  flattenInheritance(model.complexTypes, "ComplexType");
  flattenInheritance(model.entityTypes, "EntityType");
  resolvePropertyTypes(model);
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
  }

  parseDraftAnnotations(model, schemas, qualify);
  if (isV4) resolveNavigationsV4(model);
  else resolveNavigationsV2(model);
  resolvePartners(model);
  resolveDraftNavigations(model);
  return model;
}

const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

// A function that resolves a term's alias to its namespace, from the document's
// <edmx:Include Alias> and <Schema Alias>:
// "Common.DraftRoot" -> "com.sap.vocabularies.Common.v1.DraftRoot"
function termQualifier(edmx, schemas) {
  const aliases = {};
  for (const ref of list(edmx.Reference))
    for (const inc of list(ref.Include))
      if (inc.Alias) aliases[inc.Alias] = inc.Namespace;
  for (const schema of schemas)
    if (schema.Alias) aliases[schema.Alias] = schema.Namespace;
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
function parseComputed(model, schemas, qualify) {
  const computed = (annotations) =>
    list(annotations).some(
      (a) =>
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

// A derived type (BaseType) gets its base's key, properties and navigations copied in, so
// every type stands on its own and the generated $metadata needs no BaseType.
function flattenInheritance(types, kind) {
  const done = new Set();
  const flatten = (type, seen) => {
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
    if (type.keys && type.keys.length === 0) type.keys = [...base.keys];
    if (type.navigationProperties)
      type.navigationProperties = [
        ...base.navigationProperties,
        ...type.navigationProperties,
      ];
    done.add(type.fullName);
  };
  for (const type of Object.values(types)) flatten(type, new Set());
}

// Each property points at its complex or enum type, so values can be converted and emitted.
// V2 has no collection-valued properties: those are left out of the V2 service.
function resolvePropertyTypes(model) {
  const types = [
    ...Object.values(model.entityTypes),
    ...Object.values(model.complexTypes),
  ];
  const done = new Set(); // inherited properties are shared with the base type
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
function resolveTypeRef(model, p) {
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
function parseOperations(model, schemas, isV4) {
  const typeRef = (name, type) =>
    type ? normalizeProperty({ Name: name, Type: type }, isV4) : undefined;
  const unbound = {};
  for (const schema of schemas) {
    const ns = schema.Namespace;
    if (isV4) {
      for (const kind of ["Action", "Function"]) {
        for (const o of schema[kind] || []) {
          const params = (o.Parameter || []).map((p) =>
            normalizeProperty(p, true),
          );
          const isBound = o.IsBound === "true";
          if (isBound && params.length === 0) {
            model.warnings.push(
              `operation disabled: ${kind} ${o.Name} is bound but has no binding parameter`,
            );
            continue;
          }
          const op = {
            name: o.Name,
            fullName: `${ns}.${o.Name}`,
            kind: kind.toLowerCase(),
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
          parameters: (fi.Parameter || []).map((p) =>
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

function resolveOperationTypes(model) {
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

// --- Operations on the other protocol -------------------------------------------------------
//
// V2 has no bound operations: SAP Gateway models an operation on an entity as a function
// import that takes the entity's key as parameters and names its type in sap:action-for.
// The views map between the protocols and keep the names:
//   V2 import with sap:action-for and all key parameters <-> V4 operation bound to that type
//   any other V2 function import                         <-> V4 action or function import
// In a V2 view, an operation on an entity has bindsTo: { type, setName, isCollection }; the
// service finds the entity from the key parameters.

function firstSetOf(model, typeName) {
  return Object.values(model.entitySets).find(
    (es) => es.entityType === typeName,
  )?.name;
}

function bindingParameter(et, isCollection = false) {
  return {
    name: "_it",
    type: isCollection ? `Collection(${et.fullName})` : et.fullName,
    elementType: et.fullName,
    isCollection,
    entityType: et,
    nullable: false,
  };
}

function v2ViewOfV2(model) {
  const imports = {};
  for (const op of Object.values(model.operations.imports)) {
    const et = model.entityTypes[op.actionFor];
    const byKey =
      et && et.keys.every((k) => op.parameters.some((p) => p.name === k));
    const setName =
      byKey &&
      (model.entitySets[op.entitySet]?.entityType === et.fullName
        ? op.entitySet
        : firstSetOf(model, et.fullName));
    imports[op.name] = setName
      ? { ...op, bindsTo: { type: et, setName, isCollection: false } }
      : op;
  }
  return { bound: [], imports };
}

function v4ViewOfV2(model) {
  const ns = model.container.namespace;
  const view = { bound: [], imports: {} };
  for (const op of Object.values(v2ViewOfV2(model).imports)) {
    const base = {
      name: op.name,
      fullName: `${ns}.${op.name}`,
      // V4 functions need a return type: a V2 GET import without one becomes an action
      kind: op.kind === "function" && !op.returnType ? "action" : op.kind,
      returnType: op.returnType,
    };
    if (op.bindsTo) {
      const keys = op.bindsTo.type.keys;
      view.bound.push({
        ...base,
        isBound: true,
        binding: bindingParameter(op.bindsTo.type),
        parameters: op.parameters.filter((p) => !keys.includes(p.name)),
      });
    } else {
      view.imports[op.name] = {
        ...base,
        isBound: false,
        parameters: op.parameters,
        entitySet: op.entitySet,
      };
    }
  }
  return view;
}

function v2ViewOfV4(model) {
  const imports = {};
  const skip = (op, why) =>
    model.warnings.push(`not in V2: ${op.kind} ${op.name}: ${why}`);
  const returnSet = (op) =>
    op.returnType?.entityType
      ? firstSetOf(model, op.returnType.elementType)
      : undefined;
  const uniqueName = (name, suffix) =>
    imports[name] ? `${name}_${suffix}` : name;
  // V2 function import parameters are primitive
  const primitiveParams = (op) =>
    op.parameters.every((p) => !p.complexType && !p.isCollection);

  for (const op of model.operations.bound) {
    const et = op.binding.entityType;
    if (!et) {
      skip(op, `bound to ${op.binding.type}, not an entity type`);
      continue;
    }
    const setName = firstSetOf(model, et.fullName);
    if (!setName) {
      skip(op, `no entity set for ${et.name}`);
      continue;
    }
    if (!primitiveParams(op)) {
      skip(op, "complex or collection parameters");
      continue;
    }
    const keys = op.binding.isCollection
      ? []
      : et.keys.map((k) => et.properties[k]);
    if (op.parameters.some((p) => keys.some((k) => k.name === p.name))) {
      skip(op, `a parameter has the name of a key property of ${et.name}`);
      continue;
    }
    const name = uniqueName(op.name, et.name);
    imports[name] = {
      ...op,
      name,
      isBound: false,
      binding: undefined,
      httpMethod: op.kind === "action" ? "POST" : "GET",
      parameters: [...keys, ...op.parameters],
      entitySet: returnSet(op),
      bindsTo: { type: et, setName, isCollection: op.binding.isCollection },
      actionFor: op.binding.isCollection ? undefined : et.fullName,
    };
  }
  for (const op of Object.values(model.operations.imports)) {
    if (!primitiveParams(op)) {
      skip(op, "complex or collection parameters");
      continue;
    }
    const name = uniqueName(op.name, "Import");
    imports[name] = {
      ...op,
      name,
      httpMethod: op.kind === "action" ? "POST" : "GET",
      entitySet: op.entitySet || returnSet(op),
    };
  }
  return { bound: [], imports };
}

function normalizeProperty(p, isV4) {
  const sap = {};
  for (const [k, v] of Object.entries(p))
    if (k.startsWith("sap__")) sap[k.slice(5)] = v;
  let type = p.Type,
    v2Type;
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
  };
}

// Raw "<Tag ...>...</Tag>" (or self-closing) blocks, kept verbatim for re-emission.
function extractBlocks(xml, tag) {
  const re = new RegExp(
    `<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`,
    "g",
  );
  return xml.match(re) || [];
}

function setsByType(model) {
  const out = {};
  for (const es of Object.values(model.entitySets))
    (out[es.entityType] ||= []).push(es.name);
  return out;
}

function finishNavigation(et, nav, targetType, targetSet, join, cascadeHint) {
  const dependentIsTarget = join.dependentSide === "target";
  et.navigations[nav.name] = {
    name: nav.name,
    targetSet,
    targetType: targetType.fullName,
    isCollection: nav.isCollection,
    dependentSide: join.dependentSide,
    join: join.pairs,
    // Deleting a principal takes its dependents with it when they cannot exist on their
    // own, i.e. when the foreign key is part of the dependent's key (an order's items,
    // keyed by order id + position). A plain lookup reference is left alone. V4 can also
    // say so explicitly (OnDelete Cascade / ContainsTarget).
    cascadeDelete:
      cascadeHint ||
      (dependentIsTarget &&
        join.pairs.every(([, targetProp]) =>
          targetType.keys.includes(targetProp),
        )),
  };
}

function resolveNavigationsV2(model) {
  const byType = setsByType(model);
  for (const et of Object.values(model.entityTypes)) {
    et.navigations = {};
    et.disabledNavigations = {};
    // SiblingEntity and DraftAdministrativeData: see resolveDraftNavigations
    const navs = et.navigationProperties.filter(
      (nav) => !isDraftNavigation(model, et, nav),
    );
    for (const nav of navs)
      disableOnError(model, et, nav, () => {
        const assoc = model.associations[nav.relationship];
        if (!assoc)
          throw new Error(
            `${et.name}.${nav.name}: unknown association ${nav.relationship}`,
          );
        const fromEnd = assoc.ends.find((e) => e.role === nav.fromRole);
        const toEnd = assoc.ends.find((e) => e.role === nav.toRole);
        if (!fromEnd || !toEnd)
          throw new Error(
            `${et.name}.${nav.name}: roles not found in ${assoc.name}`,
          );
        const targetType = model.entityTypes[toEnd.type];
        if (!targetType)
          throw new Error(
            `${et.name}.${nav.name}: unknown target type ${toEnd.type}`,
          );

        // Prefer the AssociationSet to pick the target entity set; fall back to "main" set of that type.
        const assocSet = model.associationSets.find(
          (as) => as.association === assoc.fullName,
        );
        const targetSet =
          assocSet?.ends.find((e) => e.role === nav.toRole)?.entitySet ||
          (byType[toEnd.type] || [])[0];
        if (!targetSet)
          throw new Error(
            `${et.name}.${nav.name}: no entity set for ${toEnd.type}`,
          );

        nav.isCollection = toEnd.multiplicity === "*";
        const rc = assoc.referentialConstraint;
        let join;
        if (rc && rc.principal.role === nav.fromRole) {
          join = {
            dependentSide: "target",
            pairs: rc.principal.properties.map((p, i) => [
              p,
              rc.dependent.properties[i],
            ]),
          };
        } else if (rc) {
          join = {
            dependentSide: "source",
            pairs: rc.dependent.properties.map((p, i) => [
              p,
              rc.principal.properties[i],
            ]),
          };
        } else {
          join = joinByNaming(
            model,
            et,
            nav,
            targetType,
            assoc.name,
            fromEnd.multiplicity === "*",
          );
        }
        finishNavigation(et, nav, targetType, targetSet, join, false);
      });
  }
}

function resolveNavigationsV4(model) {
  const byType = setsByType(model);
  for (const et of Object.values(model.entityTypes)) {
    et.navigations = {};
    et.disabledNavigations = {};
    // SiblingEntity and DraftAdministrativeData have no join: see resolveDraftNavigations
    const navs = et.navigationProperties.filter(
      (nav) => !isDraftNavigation(model, et, nav),
    );
    for (const nav of navs)
      disableOnError(model, et, nav, () => {
        const m = nav.type.match(/^Collection\((.+)\)$/);
        nav.isCollection = !!m;
        const targetTypeName = m ? m[1] : nav.type;
        const targetType = model.entityTypes[targetTypeName];
        if (!targetType)
          throw new Error(
            `${et.name}.${nav.name}: unknown target type ${targetTypeName}`,
          );

        let targetSet;
        for (const setName of byType[et.fullName] || []) {
          const binding = model.entitySets[setName].bindings.find(
            (b) => b.path === nav.name,
          );
          if (binding) {
            targetSet = binding.target;
            break;
          }
        }
        targetSet ||= (byType[targetTypeName] || [])[0];
        if (!targetSet)
          throw new Error(
            `${et.name}.${nav.name}: no entity set for ${targetTypeName}`,
          );

        let join;
        if (nav.constraints.length) {
          join = {
            dependentSide: "source",
            pairs: nav.constraints.map((c) => [
              c.property,
              c.referencedProperty,
            ]),
          };
        } else {
          // The constraint lives on the dependent side; for the other direction look at the partner.
          const partner = nav.partner
            ? targetType.navigationProperties.find(
                (p) => p.name === nav.partner,
              )
            : targetType.navigationProperties.find(
                (p) =>
                  p.type.replace(/^Collection\((.+)\)$/, "$1") ===
                    et.fullName && p.constraints.length,
              );
          if (partner && partner.constraints.length) {
            join = {
              dependentSide: "target",
              pairs: partner.constraints.map((c) => [
                c.referencedProperty,
                c.property,
              ]),
            };
          } else {
            // Many on the source's end: the partner (named, or else any navigation back) is a collection
            const back =
              targetType.navigationProperties.find(
                (p) => p.name === nav.partner,
              ) ||
              targetType.navigationProperties.find(
                (p) =>
                  p.type.replace(/^Collection\((.+)\)$/, "$1") === et.fullName,
              );
            join = joinByNaming(
              model,
              et,
              nav,
              targetType,
              nav.name,
              /^Collection\(/.test(back?.type || ""),
            );
          }
        }
        finishNavigation(
          et,
          nav,
          targetType,
          targetSet,
          join,
          nav.onDeleteCascade || nav.containsTarget,
        );
      });
  }
}

// A navigation the server cannot resolve (unknown association, no join condition, ...) is
// switched off instead of failing the whole model: real services often have a few, e.g.
// many-to-many links. Requests that use it get a 501; everything else keeps working.
function disableOnError(model, et, nav, resolve) {
  try {
    resolve();
  } catch (e) {
    et.disabledNavigations[nav.name] = e.message;
    model.warnings.push(`navigation disabled: ${e.message}`);
  }
}

// Join condition by naming convention, for a navigation with no ReferentialConstraint on
// either side. The first that fits wins:
//   1. the target carries the source's key names (parent -> children: an item keyed by
//      SalesOrder + ItemNo under a sales order keyed by SalesOrder)
//   2. the source carries the target's key names (child -> parent)
//   3. a foreign key named after the other side, for a single key K: <Source>K or
//      <Source>_K on the target (Item.OrderID), <nav>K, <nav>_K, <Target>K or <Target>_K
//      on the source (Item.OrderID, CAP's author_ID)
// A match of 1 or 2 that is the other side's whole key too joins the two keys to each other,
// one row to one row. That suits a one-to-one link, but not a navigation with a "many" side
// (an order's ID is not its items' ID) or one from a type to itself, so it is skipped there.
// sourceIsMany: whether the source's end is "many" (V2's multiplicity, V4's partner).
// Every join found this way is logged: it's a guess.
function joinByNaming(
  model,
  sourceType,
  nav,
  targetType,
  relationshipName,
  sourceIsMany,
) {
  const many = nav.isCollection || sourceIsMany || sourceType === targetType;
  // Joins one side's whole key to the other's: the props, all of `type`'s keys
  const isWholeKey = (type, props) =>
    props.length === type.keys.length &&
    type.keys.every((k) => props.includes(k));
  const found = (dependentSide, pairs) => {
    const on = pairs
      .map(([s, t]) => `${sourceType.name}.${s} = ${targetType.name}.${t}`)
      .join(", ");
    model.warnings.push(
      `navigation joined by naming: ${sourceType.name}.${nav.name} on ${on} (no ReferentialConstraint)`,
    );
    return { dependentSide, pairs };
  };

  // An empty key list would "match" by default and join every row to every row
  if (
    sourceType.keys.length &&
    sourceType.keys.every((k) => targetType.properties[k]) &&
    !(many && isWholeKey(targetType, sourceType.keys))
  )
    return found(
      "target",
      sourceType.keys.map((k) => [k, k]),
    );
  if (
    targetType.keys.length &&
    targetType.keys.every((k) => sourceType.properties[k]) &&
    !(many && isWholeKey(sourceType, targetType.keys))
  )
    return found(
      "source",
      targetType.keys.map((k) => [k, k]),
    );

  // Gateway entity types are often named <Entity>Type
  const base = (type) => type.name.replace(/Type$/, "");
  const named = (type, names) =>
    names.find((n) => type.properties[n] && !type.keys.includes(n));
  if (sourceType.keys.length === 1) {
    const k = sourceType.keys[0];
    const fk = named(targetType, [
      `${base(sourceType)}${k}`,
      `${base(sourceType)}_${k}`,
    ]);
    if (fk) return found("target", [[k, fk]]);
  }
  if (targetType.keys.length === 1) {
    const k = targetType.keys[0];
    const fk = named(sourceType, [
      `${nav.name}${k}`,
      `${nav.name}_${k}`,
      `${base(targetType)}${k}`,
      `${base(targetType)}_${k}`,
    ]);
    if (fk) return found("source", [[fk, k]]);
  }
  throw new Error(
    `${sourceType.name}.${nav.name}: cannot derive join condition for ${relationshipName} - ` +
      `add a ReferentialConstraint to metadata.xml`,
  );
}

// Marks navigations that are each other's inverse, so V2 emission can share one
// Association between them and V4 emission can write Partner.
function resolvePartners(model) {
  for (const et of Object.values(model.entityTypes)) {
    for (const nav of Object.values(et.navigations)) {
      const target = model.entityTypes[nav.targetType];
      const reverse = nav.join.map(([s, t]) => [t, s]);
      const partner = Object.values(target.navigations).find(
        (back) =>
          back.targetType === et.fullName &&
          JSON.stringify(back.join) === JSON.stringify(reverse) &&
          back !== nav,
      );
      nav.partner = partner?.name;
    }
  }
}

// --- Emission -----------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}
function attrs(pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
}
function typesByNamespace(model) {
  const out = {};
  const ns = (name) =>
    (out[name] ||= { enumTypes: [], complexTypes: [], entityTypes: [] });
  for (const t of Object.values(model.enumTypes))
    ns(t.namespace).enumTypes.push(t);
  for (const t of Object.values(model.complexTypes))
    ns(t.namespace).complexTypes.push(t);
  for (const t of Object.values(model.entityTypes))
    ns(t.namespace).entityTypes.push(t);
  ns(model.container.namespace);
  return out;
}

function propertyV4(p, indent) {
  const a = attrs([
    ["Name", p.name],
    ["Type", p.type],
    ["Nullable", p.nullable ? undefined : "false"],
    ["MaxLength", p.maxLength],
    ["Precision", p.precision],
    ["Scale", p.scale],
  ]);
  if (!p.label) return [`${indent}<Property${a}/>`];
  return [
    `${indent}<Property${a}>`,
    `${indent}  <Annotation Term="Common.Label" String="${esc(p.label)}"/>`,
    `${indent}</Property>`,
  ];
}

function propertyV2(p, indent) {
  const a = attrs([
    ["Name", p.name],
    ["Type", p.v2Type],
    ["Nullable", p.nullable ? undefined : "false"],
    ["MaxLength", p.maxLength],
    ["Precision", p.precision],
    ["Scale", p.scale],
    ["sap:label", p.label],
    ["sap:display-format", p.type === "Edm.Date" ? "Date" : undefined],
  ]);
  return p.v2Omit ? [] : [`${indent}<Property${a}/>`];
}

function parameterV4(p, indent) {
  const a = attrs([
    ["Name", p.name],
    ["Type", p.type],
    ["Nullable", p.nullable ? undefined : "false"],
    ["MaxLength", p.maxLength],
    ["Precision", p.precision],
    ["Scale", p.scale],
  ]);
  return `${indent}<Parameter${a}/>`;
}

// <Action>/<Function> elements for a V4 view: bound operations and those behind imports
function operationsV4(view, indent) {
  const out = [];
  for (const op of [...view.bound, ...Object.values(view.imports)]) {
    const tag = op.kind === "action" ? "Action" : "Function";
    const children = [op.binding, ...op.parameters]
      .filter(Boolean)
      .map((p) => parameterV4(p, `${indent}  `));
    if (op.returnType)
      children.push(
        `${indent}  <ReturnType Type="${esc(op.returnType.type)}"/>`,
      );
    // EntitySetPath marks the result as the binding entity; without it UI5's V4 model
    // doesn't update the page with the result (e.g. after Approve)
    const returnsBinding =
      op.isBound &&
      op.returnType?.entityType &&
      op.returnType.elementType === op.binding.elementType;
    const a = attrs([
      ["Name", op.name],
      ["IsBound", op.isBound ? "true" : undefined],
      ["EntitySetPath", returnsBinding ? op.binding.name : undefined],
    ]);
    if (children.length)
      out.push(`${indent}<${tag}${a}>`, ...children, `${indent}</${tag}>`);
    else out.push(`${indent}<${tag}${a}/>`);
  }
  return out;
}

// V2 type name: complex and entity types unchanged, enums as Edm.String, V4-only types
// (Edm.Date, ...) mapped to their V2 counterparts
function v2TypeName(p) {
  const element =
    p.complexType || p.entityType
      ? p.elementType
      : p.enumType
        ? "Edm.String"
        : CANONICAL_TO_V2[p.elementType] || p.elementType;
  return p.isCollection ? `Collection(${element})` : element;
}

function functionImportsV2(view, indent) {
  const out = [];
  for (const op of Object.values(view.imports)) {
    const a = attrs([
      ["Name", op.name],
      ["ReturnType", op.returnType ? v2TypeName(op.returnType) : undefined],
      ["EntitySet", op.entitySet],
      ["m:HttpMethod", op.httpMethod],
      ["sap:action-for", op.actionFor],
    ]);
    const params = op.parameters.map(
      (p) =>
        `${indent}  <Parameter${attrs([
          ["Name", p.name],
          ["Type", v2TypeName(p)],
          ["Mode", "In"],
          ["Nullable", p.nullable ? undefined : "false"],
          ["MaxLength", p.maxLength],
        ])}/>`,
    );
    if (params.length)
      out.push(
        `${indent}<FunctionImport${a}>`,
        ...params,
        `${indent}</FunctionImport>`,
      );
    else out.push(`${indent}<FunctionImport${a}/>`);
  }
  return out;
}

function emitV4(model) {
  const out = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push(`<edmx:Edmx Version="4.0" xmlns:edmx="${NS.v4.edmx}">`);
  for (const ref of model.referencesXml) out.push(`  ${ref}`);
  const hasLabels = Object.values(model.entityTypes).some((et) =>
    Object.values(et.properties).some((p) => p.label),
  );
  if (
    hasLabels &&
    !model.referencesXml.some((r) =>
      r.includes("com.sap.vocabularies.Common.v1"),
    )
  ) {
    out.push(
      '  <edmx:Reference Uri="https://sap.github.io/odata-vocabularies/vocabularies/Common.xml">',
    );
    out.push(
      '    <edmx:Include Namespace="com.sap.vocabularies.Common.v1" Alias="Common"/>',
    );
    out.push("  </edmx:Reference>");
  }
  out.push("  <edmx:DataServices>");
  for (const [ns, types] of Object.entries(typesByNamespace(model))) {
    out.push(`    <Schema Namespace="${esc(ns)}" xmlns="${NS.v4.edm}">`);
    for (const en of types.enumTypes) {
      const a = attrs([
        ["Name", en.name],
        ["UnderlyingType", en.underlyingType],
        ["IsFlags", en.isFlags ? "true" : undefined],
      ]);
      out.push(`      <EnumType${a}>`);
      for (const m of en.members)
        out.push(
          `        <Member${attrs([
            ["Name", m.name],
            ["Value", m.value],
          ])}/>`,
        );
      out.push("      </EnumType>");
    }
    for (const ct of types.complexTypes) {
      out.push(`      <ComplexType Name="${esc(ct.name)}">`);
      for (const p of Object.values(ct.properties))
        out.push(...propertyV4(p, "        "));
      out.push("      </ComplexType>");
    }
    for (const et of types.entityTypes) {
      out.push(`      <EntityType Name="${esc(et.name)}">`);
      out.push("        <Key>");
      for (const k of et.keys)
        out.push(`          <PropertyRef Name="${esc(k)}"/>`);
      out.push("        </Key>");
      for (const p of Object.values(et.properties))
        out.push(...propertyV4(p, "        "));
      for (const nav of Object.values(et.navigations)) {
        const type = nav.isCollection
          ? `Collection(${nav.targetType})`
          : nav.targetType;
        const a = attrs([
          ["Name", nav.name],
          ["Type", type],
          ["Partner", nav.partner],
        ]);
        const children = [];
        if (nav.dependentSide === "source") {
          for (const [src, tgt] of nav.join)
            children.push(
              `          <ReferentialConstraint Property="${esc(
                src,
              )}" ReferencedProperty="${esc(tgt)}"/>`,
            );
        }
        if (nav.cascadeDelete)
          children.push('          <OnDelete Action="Cascade"/>');
        if (children.length)
          out.push(
            `        <NavigationProperty${a}>`,
            ...children,
            "        </NavigationProperty>",
          );
        else out.push(`        <NavigationProperty${a}/>`);
      }
      out.push("      </EntityType>");
    }
    if (ns === model.container.namespace) {
      const view = model.operationViews["4.0"];
      out.push(...operationsV4(view, "      "));
      out.push(`      <EntityContainer Name="${esc(model.container.name)}">`);
      for (const es of Object.values(model.entitySets)) {
        const et = model.entityTypes[es.entityType];
        const navs = Object.values(et.navigations);
        if (navs.length === 0) {
          out.push(
            `        <EntitySet Name="${esc(es.name)}" EntityType="${esc(
              es.entityType,
            )}"/>`,
          );
          continue;
        }
        out.push(
          `        <EntitySet Name="${esc(es.name)}" EntityType="${esc(
            es.entityType,
          )}">`,
        );
        for (const nav of navs)
          out.push(
            `          <NavigationPropertyBinding Path="${esc(
              nav.name,
            )}" Target="${esc(nav.targetSet)}"/>`,
          );
        out.push("        </EntitySet>");
      }
      for (const op of Object.values(view.imports)) {
        const [tag, attr] =
          op.kind === "action"
            ? ["ActionImport", "Action"]
            : ["FunctionImport", "Function"];
        const a = attrs([
          ["Name", op.name],
          [attr, op.fullName],
          ["EntitySet", op.entitySet],
          [
            "IncludeInServiceDocument",
            op.kind === "function" ? "true" : undefined,
          ],
        ]);
        out.push(`        <${tag}${a}/>`);
      }
      out.push("      </EntityContainer>");
      for (const block of model.annotationsXml) out.push(`      ${block}`);
    }
    out.push("    </Schema>");
  }
  out.push("  </edmx:DataServices>");
  out.push("</edmx:Edmx>");
  return out.join("\n") + "\n";
}

function emitV2(model) {
  const byType = setsByType(model);

  // One Association per navigation pair (a navigation and its partner share it).
  const associations = [];
  const navAssoc = {}; // "Type/nav" -> { assoc, fromRole, toRole }
  for (const et of Object.values(model.entityTypes)) {
    for (const nav of Object.values(et.navigations)) {
      const key = `${et.fullName}/${nav.name}`;
      if (navAssoc[key]) continue;
      const targetType = model.entityTypes[nav.targetType];
      const partner = nav.partner
        ? targetType.navigations[nav.partner]
        : undefined;
      const name = `${et.name}_${nav.name}`;
      const fromRole = `FromRole_${name}`,
        toRole = `ToRole_${name}`;
      const fromMultiplicity = partner
        ? partner.isCollection
          ? "*"
          : "1"
        : nav.isCollection
          ? "1"
          : "*";
      const toMultiplicity = nav.isCollection ? "*" : "1";
      const principalIsSource = nav.dependentSide === "target";
      const assoc = {
        name,
        ends: [
          {
            role: fromRole,
            type: et.fullName,
            multiplicity: fromMultiplicity,
            set: (byType[et.fullName] || [])[0],
          },
          {
            role: toRole,
            type: nav.targetType,
            multiplicity: toMultiplicity,
            set: nav.targetSet,
          },
        ],
        principal: {
          role: principalIsSource ? fromRole : toRole,
          properties: nav.join.map(([s, t]) => (principalIsSource ? s : t)),
        },
        dependent: {
          role: principalIsSource ? toRole : fromRole,
          properties: nav.join.map(([s, t]) => (principalIsSource ? t : s)),
        },
      };
      associations.push(assoc);
      navAssoc[key] = { assoc, fromRole, toRole };
      if (partner)
        navAssoc[`${nav.targetType}/${partner.name}`] = {
          assoc,
          fromRole: toRole,
          toRole: fromRole,
        };
    }
  }

  const out = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push(
    `<edmx:Edmx Version="1.0" xmlns:edmx="${NS.v2.edmx}" xmlns:m="${NS.v2.m}" xmlns:sap="${NS.v2.sap}">`,
  );
  for (const ref of model.referencesXml) out.push(`  ${ref}`);
  out.push('  <edmx:DataServices m:DataServiceVersion="2.0">');
  for (const [ns, types] of Object.entries(typesByNamespace(model))) {
    out.push(`    <Schema Namespace="${esc(ns)}" xmlns="${NS.v2.edm}">`);
    // V2 has no enums: enum-typed properties are Edm.String (see resolvePropertyTypes)
    for (const ct of types.complexTypes) {
      out.push(`      <ComplexType Name="${esc(ct.name)}">`);
      for (const p of Object.values(ct.properties))
        out.push(...propertyV2(p, "        "));
      out.push("      </ComplexType>");
    }
    for (const et of types.entityTypes) {
      out.push(
        `      <EntityType Name="${esc(et.name)}" sap:content-version="1">`,
      );
      out.push("        <Key>");
      for (const k of et.keys)
        out.push(`          <PropertyRef Name="${esc(k)}"/>`);
      out.push("        </Key>");
      for (const p of Object.values(et.properties))
        out.push(...propertyV2(p, "        "));
      for (const nav of Object.values(et.navigations)) {
        const { assoc, fromRole, toRole } =
          navAssoc[`${et.fullName}/${nav.name}`];
        out.push(
          `        <NavigationProperty Name="${esc(
            nav.name,
          )}" Relationship="${esc(
            `${model.container.namespace}.${assoc.name}`,
          )}" FromRole="${fromRole}" ToRole="${toRole}"/>`,
        );
      }
      out.push("      </EntityType>");
    }
    if (ns === model.container.namespace) {
      for (const assoc of associations) {
        out.push(`      <Association Name="${esc(assoc.name)}">`);
        for (const end of assoc.ends)
          out.push(
            `        <End Role="${end.role}" Type="${esc(
              end.type,
            )}" Multiplicity="${end.multiplicity}"/>`,
          );
        out.push("        <ReferentialConstraint>");
        out.push(`          <Principal Role="${assoc.principal.role}">`);
        for (const p of assoc.principal.properties)
          out.push(`            <PropertyRef Name="${esc(p)}"/>`);
        out.push("          </Principal>");
        out.push(`          <Dependent Role="${assoc.dependent.role}">`);
        for (const p of assoc.dependent.properties)
          out.push(`            <PropertyRef Name="${esc(p)}"/>`);
        out.push("          </Dependent>");
        out.push("        </ReferentialConstraint>");
        out.push("      </Association>");
      }
      out.push(
        `      <EntityContainer Name="${esc(
          model.container.name,
        )}" m:IsDefaultEntityContainer="true">`,
      );
      for (const es of Object.values(model.entitySets)) {
        out.push(
          `        <EntitySet Name="${esc(es.name)}" EntityType="${esc(
            es.entityType,
          )}" sap:content-version="1"/>`,
        );
      }
      for (const assoc of associations) {
        out.push(
          `        <AssociationSet Name="${esc(
            assoc.name,
          )}_AssocSet" Association="${esc(
            `${model.container.namespace}.${assoc.name}`,
          )}" sap:content-version="1">`,
        );
        for (const end of assoc.ends)
          out.push(
            `          <End Role="${end.role}" EntitySet="${esc(end.set)}"/>`,
          );
        out.push("        </AssociationSet>");
      }
      out.push(...functionImportsV2(model.operationViews["2.0"], "        "));
      out.push("      </EntityContainer>");
      for (const block of model.annotationsXml) out.push(`      ${block}`);
    }
    out.push("    </Schema>");
  }
  out.push("  </edmx:DataServices>");
  out.push("</edmx:Edmx>");
  return out.join("\n") + "\n";
}

module.exports = { parseMetadata, emitV2, emitV4 };
