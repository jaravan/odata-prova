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
      "NavigationPropertyBinding",
      "Annotation",
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
    entityTypes: {},
    entitySets: {},
    container: undefined,
    associations: {},
    associationSets: [],
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
    for (const nav of et.navigationProperties) {
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
    }
  }
}

function resolveNavigationsV4(model) {
  const byType = setsByType(model);
  for (const et of Object.values(model.entityTypes)) {
    et.navigations = {};
    for (const nav of et.navigationProperties) {
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
    }
  }
}

// Join condition by naming convention: the target carries properties named like the
// source's keys (parent -> children), or the source carries the target's key names
// (child -> parent).
function joinByNaming(sourceType, nav, targetType, relationshipName) {
  if (sourceType.keys.every((k) => targetType.properties[k])) {
    return {
      dependentSide: "target",
      pairs: sourceType.keys.map((k) => [k, k]),
    };
  }
  if (targetType.keys.every((k) => sourceType.properties[k])) {
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
  for (const et of Object.values(model.entityTypes))
    (out[et.namespace] ||= []).push(et);
  out[model.container.namespace] ||= [];
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
    for (const et of types) {
      out.push(`      <EntityType Name="${esc(et.name)}">`);
      out.push("        <Key>");
      for (const k of et.keys)
        out.push(`          <PropertyRef Name="${esc(k)}"/>`);
      out.push("        </Key>");
      for (const p of Object.values(et.properties)) {
        const a = attrs([
          ["Name", p.name],
          ["Type", p.type],
          ["Nullable", p.nullable ? undefined : "false"],
          ["MaxLength", p.maxLength],
          ["Precision", p.precision],
          ["Scale", p.scale],
        ]);
        if (p.label) {
          out.push(`        <Property${a}>`);
          out.push(
            `          <Annotation Term="Common.Label" String="${esc(p.label)}"/>`,
          );
          out.push("        </Property>");
        } else {
          out.push(`        <Property${a}/>`);
        }
      }
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
    for (const et of types) {
      out.push(
        `      <EntityType Name="${esc(et.name)}" sap:content-version="1">`,
      );
      out.push("        <Key>");
      for (const k of et.keys)
        out.push(`          <PropertyRef Name="${esc(k)}"/>`);
      out.push("        </Key>");
      for (const p of Object.values(et.properties)) {
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
        out.push(`        <Property${a}/>`);
      }
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
