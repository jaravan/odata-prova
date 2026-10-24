// The V4 annotations of a V4 document, for the V2 metadata generated from it (see emitV2).
// UI5's V2 model reads V4 annotations from $metadata, and they win over what it derives
// from sap: attributes, so the V2 metadata carries them as they are, except:
// - each <Annotations> block is put in the V4 namespace: UI5 reads blocks in that namespace
//   only, and a V4 document's blocks inherit it from their <Schema>, which V2 doesn't have
// - each <edmx:Reference> declares V4's edmx namespace, as SAP Gateway writes them: in V2
//   metadata the edmx prefix is V2's, and UI5 resolves a term's alias (UI.Hidden) only
//   from references in V4's, so the term would be read under its alias
// - an annotation written inline on an element (a property, an action) moves into a block
//   targeting the element, since V2 elements can't carry one (see inlineAnnotations)
// - targets are written as V2 has them: a schema alias resolved (UI5 resolves only those of
//   <edmx:Reference>), and an action, function (Ns.Approve(Ns.Order)) or action import
//   (Ns.Container/Approve) targeted as the function import V2 serves it as
// - the actions a draft annotation names are named as their function imports
// It also gives the sap: attributes UI5 reads where V2 has no annotation of its own:
// - sap:searchable="true", unless the annotations say Searchable false: without it, UI5
//   takes an entity set as not searchable, while V4's default is searchable
// - sap:applicable-path, from Core.OperationAvailable on a bound action, which is what
//   enables the action's button in Fiori Elements V2

import type { Model, Operation } from "./model.ts";
import { own } from "./query.ts";

const EDM_V4 = "http://docs.oasis-open.org/odata/ns/edm";
const EDMX_V4 = "http://docs.oasis-open.org/odata/ns/edmx";

// An element's start or end tag (with its attributes), or a comment, processing
// instruction or CDATA section, which are skipped
const TAG =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([\w.:-]+)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

const attr = (tag: string, name: string): string | undefined =>
  tag
    .match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`))
    ?.slice(1)
    .find((v) => v !== undefined);

// The element's source text, its lines after the first unindented by the first's column
function slice(xml: string, start: number, end: number): string {
  const column = start - (xml.lastIndexOf("\n", start - 1) + 1);
  return xml
    .slice(start, end)
    .split("\n")
    .map((line, i) =>
      i === 0 ? line : line.replace(new RegExp(`^ {0,${column}}`), ""),
    )
    .join("\n");
}

// Laid out for where the emitters write blocks: inside <Schema>, 6 spaces in
function block(target: string, annotations: string[]): string {
  return [
    `<Annotations Target="${esc(target)}" xmlns="${EDM_V4}">`,
    ...annotations.map((a) => a.replace(/^/gm, "        ")),
    "      </Annotations>",
  ].join("\n");
}

// The annotations written inline on the document's elements, as <Annotations> blocks
// targeting each element the way a block would ("Ns.Type/Property", "Ns.Container/Set",
// "Ns.Approve(Ns.Order)" for a bound action, "Ns.Approve" for an unbound one). Elements V2
// has no place for, such as enum types and terms, are left out; so are blocks, which the
// document has already.
function inlineAnnotations(xml: string): string[] {
  const byTarget = new Map<string, string[]>();
  const add = (target: string, annotation: string) => {
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target)!.push(annotation);
  };
  // Open elements; target: what an annotation inside it targets (relative to the action or
  // function for its parameters, whose target is known only at its end tag)
  const stack: { name: string; target?: string }[] = [];
  let ns = "",
    type = "",
    container = "";
  let operation:
    | {
        name: string;
        isBound: boolean;
        binding?: string;
        annotations: [string, string][];
      }
    | undefined;
  // An annotation being read: from start, until the stack is back to depth
  let reading: { start: number; depth: number; target: string } | undefined;

  for (const m of xml.matchAll(TAG)) {
    const [tag, isEnd, qname, attrs = "", selfClosing] = m;
    if (!qname) continue;
    const name = qname.slice(qname.indexOf(":") + 1);
    const end = m.index + tag.length;
    if (isEnd) {
      const closed = stack.pop();
      if (reading && stack.length === reading.depth) {
        const annotation = slice(xml, reading.start, end);
        if (operation) operation.annotations.push([reading.target, annotation]);
        else add(reading.target, annotation);
        reading = undefined;
      } else if (operation && closed?.target === "") {
        // The action or function's end: its target needs the binding parameter's type
        const target = operation.isBound
          ? `${operation.name}(${operation.binding})`
          : operation.name;
        for (const [rel, annotation] of operation.annotations)
          add(`${target}${rel}`, annotation);
        operation = undefined;
      }
      continue;
    }
    if (reading) {
      if (!selfClosing) stack.push({ name });
      continue;
    }
    const parent = stack[stack.length - 1];
    if (name === "Annotation" && parent?.target !== undefined) {
      if (selfClosing) {
        if (operation) operation.annotations.push([parent.target, tag]);
        else add(parent.target, tag);
      } else {
        reading = {
          start: m.index,
          depth: stack.length,
          target: parent.target,
        };
        stack.push({ name });
      }
      continue;
    }

    const elName = attr(attrs, "Name") ?? "";
    let target: string | undefined;
    if (name === "Schema") {
      ns = attr(attrs, "Namespace") ?? "";
      target = ns;
    } else if (name === "EntityType" || name === "ComplexType") {
      type = `${ns}.${elName}`;
      target = type;
    } else if (
      (name === "Property" || name === "NavigationProperty") &&
      (parent?.name === "EntityType" || parent?.name === "ComplexType")
    ) {
      target = `${type}/${elName}`;
    } else if (name === "EntityContainer") {
      container = `${ns}.${elName}`;
      target = container;
    } else if (
      ["EntitySet", "Singleton", "ActionImport", "FunctionImport"].includes(
        name,
      ) &&
      parent?.name === "EntityContainer"
    ) {
      target = `${container}/${elName}`;
    } else if (
      (name === "Action" || name === "Function") &&
      parent?.name === "Schema"
    ) {
      operation = {
        name: `${ns}.${elName}`,
        isBound: attr(attrs, "IsBound") === "true",
        annotations: [],
      };
      if (selfClosing) operation = undefined;
      else target = "";
    } else if (name === "Parameter" && operation && parent?.target === "") {
      operation.binding ??= attr(attrs, "Type");
      target = `/${elName}`;
    } else if (name === "Parameter" && parent?.name === "FunctionImport") {
      // A V2 document's function import
      target = `${parent.target}/${elName}`;
    }
    if (!selfClosing) stack.push({ name, target });
  }
  return [...byTarget].map(([target, annotations]) =>
    block(target, annotations),
  );
}

// The V2 metadata's blocks, and the sap: attributes taken from them
export interface AnnotationsV2 {
  references: string[];
  blocks: string[];
  // Entity sets whose annotations say Searchable false
  notSearchable: Set<string>;
  // sap:applicable-path by function import
  applicablePaths: Record<string, string>;
}

function annotationsV2(model: Model): AnnotationsV2 {
  const qualify = (name: string) => {
    const dot = name.lastIndexOf(".");
    const prefix = name.slice(0, dot);
    return `${model.aliases[prefix] ?? prefix}${name.slice(dot)}`;
  };
  // A type in a signature: Ns.Type or Collection(Ns.Type)
  const qualifyType = (t: string) => {
    const inner = t.match(/^Collection\((.*)\)$/)?.[1];
    return inner ? `Collection(${qualify(inner.trim())})` : qualify(t.trim());
  };
  const containerName = `${model.container.namespace}.${model.container.name}`;
  const imports = Object.values(model.operationViews["2.0"].imports);
  const bindingType = (op: Operation) =>
    op.bindsTo!.isCollection
      ? `Collection(${op.bindsTo!.type.fullName})`
      : op.bindsTo!.type.fullName;

  // The V2 targets for a V4 one: an action or function may be several function imports
  // (one per binding), or none (not in V2: then the target stays as it is)
  function retarget(target: string): string[] {
    const m = target.match(/^([^/(]+)(\((?:[^()]|\([^()]*\))*\))?(.*)$/);
    if (!m) return [target];
    const [, head, signature, rest] = m;
    const name = qualify(head);
    if (name === containerName && !signature) {
      // Ns.Container/<ActionImport>[/Parameter]
      const [, importName, more] = rest.match(/^\/([^/]+)(.*)$/) || [];
      const op = imports.find(
        (o) => o.importName && o.importName === importName,
      );
      if (op) return [`${containerName}/${op.name}${more}`];
      return [`${name}${rest}`];
    }
    const ops = imports.filter(
      (o) => o.fullName === name && (o.bindsTo || o.importName),
    );
    if (!ops.length) return [`${name}${signature ?? ""}${rest}`];
    let matching = ops;
    if (signature) {
      const first = qualifyType(
        signature.slice(1, -1).split(/,(?![^(]*\))/)[0] ?? "",
      );
      const bound = ops.filter((o) => o.bindsTo && bindingType(o) === first);
      matching = bound.length ? bound : ops.filter((o) => !o.bindsTo);
    }
    return matching.map((o) => `${containerName}/${o.name}${rest}`);
  }

  // An entity set's draft annotation names its actions (EditAction="Ns.draftEdit"): in V2,
  // each is the function import of the action bound to the set's type
  // (Ns.Container/draftEdit), the way SAP Gateway writes it, which Fiori Elements V2 calls
  function draftActionsV2(body: string, member: string | undefined): string {
    const type = member && own(model.entitySets, member)?.entityType;
    if (!type) return body;
    return body.replace(/<PropertyValue\b[^>]*>/g, (tag) => {
      const name = /Action$/.test(attr(tag, "Property") ?? "")
        ? attr(tag, "String")
        : undefined;
      const op =
        name &&
        imports.find(
          (o) =>
            o.fullName === qualify(name) && o.bindsTo?.type.fullName === type,
        );
      return op
        ? tag.replace(
            /\bString\s*=\s*("[^"]*"|'[^']*')/,
            `String="${esc(`${containerName}/${op.name}`)}"`,
          )
        : tag;
    });
  }

  const blocks: string[] = [];
  const notSearchable = new Set<string>();
  const applicablePaths: Record<string, string> = {};
  for (const original of model.annotationsXml) {
    const open = original.match(/^<Annotations\b[^>]*>/)?.[0];
    const target = open && attr(open, "Target");
    if (!open || !target) {
      blocks.push(original);
      continue;
    }
    for (const t of retarget(target)) {
      let tag = open.replace(
        /\bTarget\s*=\s*("[^"]*"|'[^']*')/,
        `Target="${esc(t)}"`,
      );
      if (!/\sxmlns\s*=/.test(tag))
        tag = tag.replace(/\/?>$/, ` xmlns="${EDM_V4}"$&`);
      // An entity set or function import: the block may say what its sap: attributes are
      const member = t.startsWith(`${containerName}/`)
        ? t.slice(containerName.length + 1)
        : undefined;
      blocks.push(tag + draftActionsV2(original.slice(open.length), member));
      if (!member || member.includes("/")) continue;
      for (const a of original.matchAll(/<Annotation\b[^>]*>/g)) {
        const term = attr(a[0], "Term");
        if (!term || attr(a[0], "Qualifier")) continue;
        // The annotation's source, up to its end
        const end = a[0].endsWith("/>")
          ? a.index + a[0].length
          : original.indexOf("</Annotation>", a.index);
        const text = original.slice(a.index, end === -1 ? undefined : end);
        if (qualify(term) === "Org.OData.Capabilities.V1.SearchRestrictions") {
          const searchable = [...text.matchAll(/<PropertyValue\b[^>]*>/g)].find(
            (pv) => attr(pv[0], "Property") === "Searchable",
          );
          if (searchable && attr(searchable[0], "Bool") === "false")
            notSearchable.add(member);
        }
        if (qualify(term) === "Org.OData.Core.V1.OperationAvailable") {
          const op = imports.find((o) => o.name === member && o.bindsTo);
          const path =
            attr(a[0], "Path") ?? text.match(/<Path>([^<]*)<\/Path>/)?.[1];
          // Starts with the binding parameter in V4; V2's is relative to the entity
          if (op && path?.includes("/"))
            applicablePaths[op.name] = path.slice(path.indexOf("/") + 1);
        }
      }
    }
  }
  const references = model.referencesXml.map((ref) =>
    /^<[^>]*\sxmlns:edmx\s*=/.test(ref)
      ? ref
      : ref.replace(/^<edmx:Reference\b/, `$& xmlns:edmx="${EDMX_V4}"`),
  );
  return { references, blocks, notSearchable, applicablePaths };
}

export { inlineAnnotations, annotationsV2 };
