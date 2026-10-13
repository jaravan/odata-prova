// The V4 $metadata of a model read from a V2 document (a V4 document is served as it is).
// The document's sap: attributes become V4 annotations (see sap-annotations.ts).

import type { Model, OperationView, Property, TypedElement } from "./model.ts";
import { SapAnnotations, blocksV4 } from "./sap-annotations.ts";
import { esc, attrs, typesByNamespace } from "./emit.ts";

const NS = {
  edmx: "http://docs.oasis-open.org/odata/ns/edmx",
  edm: "http://docs.oasis-open.org/odata/ns/edm",
};

// annotations: the <Annotation> elements for the property (see SapAnnotations)
function propertyV4(
  p: Property,
  indent: string,
  annotations: string[],
): string[] {
  const a = attrs([
    ["Name", p.name],
    ["Type", p.type],
    ["Nullable", p.nullable ? undefined : "false"],
    ["MaxLength", p.maxLength],
    ["Precision", p.precision],
    ["Scale", p.scale],
  ]);
  if (!annotations.length) return [`${indent}<Property${a}/>`];
  return [
    `${indent}<Property${a}>`,
    ...annotations.map((line) => `${indent}  ${line}`),
    `${indent}</Property>`,
  ];
}

function parameterV4(p: TypedElement, indent: string): string {
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
function operationsV4(view: OperationView, indent: string): string[] {
  const out: string[] = [];
  for (const op of [...view.bound, ...Object.values(view.imports)]) {
    const tag = op.kind === "action" ? "Action" : "Function";
    const children = [op.binding, ...op.parameters]
      .filter((p) => p !== undefined)
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
      op.returnType.elementType === op.binding?.elementType;
    const a = attrs([
      ["Name", op.name],
      ["IsBound", op.isBound ? "true" : undefined],
      ["EntitySetPath", returnsBinding ? op.binding?.name : undefined],
    ]);
    if (children.length)
      out.push(`${indent}<${tag}${a}>`, ...children, `${indent}</${tag}>`);
    else out.push(`${indent}<${tag}${a}/>`);
  }
  return out;
}

// The document's sap: attributes become V4 annotations (see sap-annotations.ts). The body is
// written first: the vocabulary references it needs are known only then.
function emitV4(model: Model): string {
  const blocks = blocksV4(model);
  const sap = new SapAnnotations(model.referencesXml, blocks);
  const out: string[] = [];
  const indented = (indent: string, lines: string[]) =>
    lines.map((line) => `${indent}${line}`);
  out.push("  <edmx:DataServices>");
  for (const [ns, types] of Object.entries(typesByNamespace(model))) {
    out.push(`    <Schema Namespace="${esc(ns)}" xmlns="${NS.edm}">`);
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
        out.push(
          ...propertyV4(
            p,
            "        ",
            sap.property(p, ct.properties, `${ct.fullName}/${p.name}`),
          ),
        );
      out.push("      </ComplexType>");
    }
    for (const et of types.entityTypes) {
      out.push(`      <EntityType Name="${esc(et.name)}">`);
      out.push("        <Key>");
      for (const k of et.keys)
        out.push(`          <PropertyRef Name="${esc(k)}"/>`);
      out.push("        </Key>");
      for (const p of Object.values(et.properties))
        out.push(
          ...propertyV4(
            p,
            "        ",
            sap.property(p, et.properties, `${et.fullName}/${p.name}`),
          ),
        );
      for (const nav of Object.values(et.navigations)) {
        const type = nav.isCollection
          ? `Collection(${nav.targetType})`
          : nav.targetType;
        const a = attrs([
          ["Name", nav.name],
          ["Type", type],
          ["Partner", nav.partner],
        ]);
        const children: string[] = [];
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
      out.push(...indented("        ", sap.entityType(et)));
      out.push("      </EntityType>");
    }
    if (ns === model.container.namespace) {
      const view = model.operationViews["4.0"];
      out.push(...operationsV4(view, "      "));
      out.push(`      <EntityContainer Name="${esc(model.container.name)}">`);
      for (const es of Object.values(model.entitySets)) {
        const et = model.entityTypes[es.entityType];
        const children = [
          ...Object.values(et.navigations).map(
            (nav) =>
              `<NavigationPropertyBinding Path="${esc(
                nav.name,
              )}" Target="${esc(nav.targetSet)}"/>`,
          ),
          ...sap.entitySet(
            es,
            et,
            `${model.container.namespace}.${model.container.name}/${es.name}`,
          ),
        ];
        const open = `<EntitySet Name="${esc(es.name)}" EntityType="${esc(
          es.entityType,
        )}"`;
        if (children.length === 0) {
          out.push(`        ${open}/>`);
          continue;
        }
        out.push(
          `        ${open}>`,
          ...indented("          ", children),
          "        </EntitySet>",
        );
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
      for (const block of blocks) out.push(`      ${block}`);
    }
    out.push("    </Schema>");
  }
  out.push("  </edmx:DataServices>");
  out.push("</edmx:Edmx>");
  return (
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<edmx:Edmx Version="4.0" xmlns:edmx="${NS.edmx}">`,
      ...indented("  ", model.referencesXml),
      ...indented("  ", sap.references()),
      ...out,
    ].join("\n") + "\n"
  );
}

export { emitV4 };
