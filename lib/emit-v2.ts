// The V2 $metadata of a model read from a V4 document (a V2 document is served as it is).
// The document's V4 annotations are written as UI5's V2 model reads them (see
// annotations-v2.ts).

import type { Model, OperationView, Property, TypedElement } from "./model.ts";
import { CANONICAL_TO_V2 } from "./types.ts";
import { annotationsV2 } from "./annotations-v2.ts";
import type { AnnotationsV2 } from "./annotations-v2.ts";
import { setsByType } from "./navigations.ts";
import { esc, attrs, typesByNamespace } from "./emit.ts";

const NS = {
  edmx: "http://schemas.microsoft.com/ado/2007/06/edmx",
  m: "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata",
  edm: "http://schemas.microsoft.com/ado/2008/09/edm",
  sap: "http://www.sap.com/Protocols/SAPData",
};

// etag: the property is part of an entity set's ETag (see etag.ts)
function propertyV2(p: Property, indent: string, etag = false): string[] {
  const a = attrs([
    ["Name", p.name],
    ["Type", p.v2Type],
    ["Nullable", p.nullable ? undefined : "false"],
    ["MaxLength", p.maxLength],
    ["Precision", p.precision],
    ["Scale", p.scale],
    ["ConcurrencyMode", etag ? "Fixed" : undefined],
    ["sap:label", p.label],
    ["sap:display-format", p.type === "Edm.Date" ? "Date" : undefined],
  ]);
  return p.v2Omit ? [] : [`${indent}<Property${a}/>`];
}

// V2 type name: complex and entity types unchanged, enums as Edm.String, V4-only types
// (Edm.Date, ...) mapped to their V2 counterparts
function v2TypeName(p: TypedElement): string {
  const element =
    p.complexType || p.entityType
      ? p.elementType
      : p.enumType
        ? "Edm.String"
        : CANONICAL_TO_V2[p.elementType] || p.elementType;
  return p.isCollection ? `Collection(${element})` : element;
}

// applicablePaths: sap:applicable-path by import (see annotationsV2)
function functionImportsV2(
  view: OperationView,
  indent: string,
  applicablePaths: AnnotationsV2["applicablePaths"],
): string[] {
  const out: string[] = [];
  for (const op of Object.values(view.imports)) {
    const a = attrs([
      ["Name", op.name],
      ["ReturnType", op.returnType ? v2TypeName(op.returnType) : undefined],
      ["EntitySet", op.entitySet],
      ["m:HttpMethod", op.httpMethod],
      ["sap:action-for", op.actionFor],
      ["sap:applicable-path", applicablePaths[op.name]],
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

interface AssociationOut {
  name: string;
  ends: { role: string; type: string; multiplicity: string; set: string }[];
  principal: { role: string; properties: string[] };
  dependent: { role: string; properties: string[] };
}

// The document's V4 annotations, as UI5's V2 model reads them (see annotations-v2.ts)
function emitV2(model: Model): string {
  const annotations = annotationsV2(model);
  const byType = setsByType(model);

  // One Association per navigation pair (a navigation and its partner share it).
  const associations: AssociationOut[] = [];
  // "Type/nav" -> { assoc, fromRole, toRole }
  const navAssoc: Record<
    string,
    { assoc: AssociationOut; fromRole: string; toRole: string }
  > = {};
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
      const assoc: AssociationOut = {
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

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push(
    `<edmx:Edmx Version="1.0" xmlns:edmx="${NS.edmx}" xmlns:m="${NS.m}" xmlns:sap="${NS.sap}">`,
  );
  for (const ref of annotations.references) out.push(`  ${ref}`);
  out.push('  <edmx:DataServices m:DataServiceVersion="2.0">');
  for (const [ns, types] of Object.entries(typesByNamespace(model))) {
    out.push(`    <Schema Namespace="${esc(ns)}" xmlns="${NS.edm}">`);
    // V2 has no enums: enum-typed properties are Edm.String (see resolvePropertyTypes in
    // metadata.ts)
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
      // V2 has ETags per type, V4 per entity set: those of every set of the type
      const etag = new Set(
        Object.values(model.entitySets)
          .filter((es) => es.entityType === et.fullName)
          .flatMap((es) => es.concurrency || []),
      );
      for (const p of Object.values(et.properties))
        out.push(...propertyV2(p, "        ", etag.has(p.name)));
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
        const a = attrs([
          ["Name", es.name],
          ["EntityType", es.entityType],
          [
            "sap:searchable",
            annotations.notSearchable.has(es.name) ? undefined : "true",
          ],
          ["sap:content-version", "1"],
        ]);
        out.push(`        <EntitySet${a}/>`);
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
      out.push(
        ...functionImportsV2(
          model.operationViews["2.0"],
          "        ",
          annotations.applicablePaths,
        ),
      );
      out.push("      </EntityContainer>");
      for (const block of annotations.blocks) out.push(`      ${block}`);
    }
    out.push("    </Schema>");
  }
  out.push("  </edmx:DataServices>");
  out.push("</edmx:Edmx>");
  return out.join("\n") + "\n";
}

export { emitV2 };
