const { XMLParser } = require("fast-xml-parser");
const { V2_TO_CANONICAL, CANONICAL_TO_V2 } = require("./types");

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
        members: (en.Member || []).map((m) => ({ name: m.Name, value: m.Value })),
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

  parseOperations(model, schemas, isV4);
  flattenInheritance(model.complexTypes, "ComplexType");
  flattenInheritance(model.entityTypes, "EntityType");
  resolvePropertyTypes(model);
  resolveOperationTypes(model);

  for (const es of Object.values(model.entitySets)) {
    if (!model.entityTypes[es.entityType])
      throw new Error(
        `EntitySet ${es.name}: unknown entity type ${es.entityType}`,
      );
  }

  if (isV4) resolveNavigationsV4(model);
  else resolveNavigationsV2(model);
  resolvePartners(model);
  return model;
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
      throw new Error(`${kind} ${type.fullName}: unknown BaseType ${type.baseType}`);
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

// Collection(...), complex and enum types of a property, parameter or return type
function resolveTypeRef(model, p) {
  const m = p.type.match(/^Collection\((.+)\)$/);
  p.isCollection = !!m;
  p.elementType = m ? m[1] : p.type;
  p.complexType = model.complexTypes[p.elementType];
  p.enumType = model.enumTypes[p.elementType];
  if (p.enumType) p.v2Type = "Edm.String"; // V2 has no enums: the member name
}

// Operations, shaped alike for both protocols:
//   { name, fullName, kind: "action" | "function", isBound, binding, parameters, returnType,
//     entitySet, httpMethod }
// binding, parameters and returnType are shaped like properties (see normalizeProperty).
// V4: bound actions/functions go to operations.bound; action and function imports, by the
// import's name, to operations.imports. V2 has function imports only, where m:HttpMethod
// decides between action (POST) and function (GET).
function parseOperations(model, schemas, isV4) {
  const typeRef = (name, type) => (type ? normalizeProperty({ Name: name, Type: type }, isV4) : undefined);
  const unbound = {};
  for (const schema of schemas) {
    const ns = schema.Namespace;
    if (isV4) {
      for (const kind of ["Action", "Function"]) {
        for (const o of schema[kind] || []) {
          const params = (o.Parameter || []).map((p) => normalizeProperty(p, true));
          const isBound = o.IsBound === "true";
          if (isBound && params.length === 0) {
            model.warnings.push(`operation disabled: ${kind} ${o.Name} is bound but has no binding parameter`);
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
        for (const [tag, attr] of [["ActionImport", "Action"], ["FunctionImport", "Function"]]) {
          for (const imp of container[tag] || []) {
            const op = unbound[imp[attr]];
            if (!op) {
              model.warnings.push(`operation disabled: ${tag} ${imp.Name}: unknown ${attr.toLowerCase()} ${imp[attr]}`);
              continue;
            }
            model.operations.imports[imp.Name] = { ...op, name: imp.Name, entitySet: imp.EntitySet };
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
          parameters: (fi.Parameter || []).map((p) => normalizeProperty(p, false)),
          returnType: typeRef("", fi.ReturnType),
          entitySet: fi.EntitySet,
          httpMethod,
        };
      }
    }
  }
  // Operations are served on the protocol the metadata was written for; the other
  // protocol's generated $metadata leaves them out.
  const other = isV4 ? "V2" : "V4";
  for (const op of model.operations.bound)
    model.warnings.push(`not in ${other}: ${op.kind} ${op.name} (bound to ${op.binding.type})`);
  for (const op of Object.values(model.operations.imports))
    model.warnings.push(`not in ${other}: ${isV4 ? `${op.kind} import` : "function import"} ${op.name}`);
}

function resolveOperationTypes(model) {
  const ops = [...model.operations.bound, ...Object.values(model.operations.imports)];
  for (const op of ops) {
    for (const p of [op.binding, ...op.parameters, op.returnType]) {
      if (!p) continue;
      resolveTypeRef(model, p);
      p.entityType = model.entityTypes[p.elementType];
    }
  }
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
    for (const nav of et.navigationProperties) disableOnError(model, et, nav, () => {
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
        join = joinByNaming(et, nav, targetType, assoc.name);
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
    for (const nav of et.navigationProperties) disableOnError(model, et, nav, () => {
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
          pairs: nav.constraints.map((c) => [c.property, c.referencedProperty]),
        };
      } else {
        // The constraint lives on the dependent side; for the other direction look at the partner.
        const partner = nav.partner
          ? targetType.navigationProperties.find((p) => p.name === nav.partner)
          : targetType.navigationProperties.find(
              (p) =>
                p.type.replace(/^Collection\((.+)\)$/, "$1") === et.fullName &&
                p.constraints.length,
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
          join = joinByNaming(et, nav, targetType, nav.name);
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

// Join condition by naming convention: the target carries properties named like the
// source's keys (parent -> children), or the source carries the target's key names
// (child -> parent).
function joinByNaming(sourceType, nav, targetType, relationshipName) {
  // An empty key list would "match" by default and join every row to every row
  if (sourceType.keys.length && sourceType.keys.every((k) => targetType.properties[k])) {
    return {
      dependentSide: "target",
      pairs: sourceType.keys.map((k) => [k, k]),
    };
  }
  if (targetType.keys.length && targetType.keys.every((k) => sourceType.properties[k])) {
    return {
      dependentSide: "source",
      pairs: targetType.keys.map((k) => [k, k]),
    };
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
  for (const t of Object.values(model.enumTypes)) ns(t.namespace).enumTypes.push(t);
  for (const t of Object.values(model.complexTypes)) ns(t.namespace).complexTypes.push(t);
  for (const t of Object.values(model.entityTypes)) ns(t.namespace).entityTypes.push(t);
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
        out.push(`        <Member${attrs([["Name", m.name], ["Value", m.value]])}/>`);
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
              `          <ReferentialConstraint Property="${esc(src)}" ReferencedProperty="${esc(tgt)}"/>`,
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
      out.push(`      <EntityContainer Name="${esc(model.container.name)}">`);
      for (const es of Object.values(model.entitySets)) {
        const et = model.entityTypes[es.entityType];
        const navs = Object.values(et.navigations);
        if (navs.length === 0) {
          out.push(
            `        <EntitySet Name="${esc(es.name)}" EntityType="${esc(es.entityType)}"/>`,
          );
          continue;
        }
        out.push(
          `        <EntitySet Name="${esc(es.name)}" EntityType="${esc(es.entityType)}">`,
        );
        for (const nav of navs)
          out.push(
            `          <NavigationPropertyBinding Path="${esc(nav.name)}" Target="${esc(nav.targetSet)}"/>`,
          );
        out.push("        </EntitySet>");
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
          `        <NavigationProperty Name="${esc(nav.name)}" Relationship="${esc(`${model.container.namespace}.${assoc.name}`)}" FromRole="${fromRole}" ToRole="${toRole}"/>`,
        );
      }
      out.push("      </EntityType>");
    }
    if (ns === model.container.namespace) {
      for (const assoc of associations) {
        out.push(`      <Association Name="${esc(assoc.name)}">`);
        for (const end of assoc.ends)
          out.push(
            `        <End Role="${end.role}" Type="${esc(end.type)}" Multiplicity="${end.multiplicity}"/>`,
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
        `      <EntityContainer Name="${esc(model.container.name)}" m:IsDefaultEntityContainer="true">`,
      );
      for (const es of Object.values(model.entitySets)) {
        out.push(
          `        <EntitySet Name="${esc(es.name)}" EntityType="${esc(es.entityType)}" sap:content-version="1"/>`,
        );
      }
      for (const assoc of associations) {
        out.push(
          `        <AssociationSet Name="${esc(assoc.name)}_AssocSet" Association="${esc(`${model.container.namespace}.${assoc.name}`)}" sap:content-version="1">`,
        );
        for (const end of assoc.ends)
          out.push(
            `          <End Role="${end.role}" EntitySet="${esc(end.set)}"/>`,
          );
        out.push("        </AssociationSet>");
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

module.exports = { parseMetadata, emitV2, emitV4 };
