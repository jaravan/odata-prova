// The V4 annotations that stand for a V2 document's sap: attributes, for the V4 metadata
// generated from it (see emitV4). Each attribute maps to the term SAP names for it in
// "SAP Annotations for OData Version 2.0"
// (https://sap.github.io/odata-vocabularies/docs/v2-annotations.html):
//
//   Property    label, heading, quickinfo      Common.Label, Heading, QuickInfo
//               text="Path"                    Common.Text
//               unit="Path"                    Measures.ISOCurrency (to a currency code) or Unit
//               semantics="currency-code"      Common.IsCurrency ("unit-of-measure": IsUnit)
//               display-format="UpperCase"     Common.IsUpperCase
//               field-control="Path"           Common.FieldControl
//               value-list="fixed-values"      Common.ValueListWithFixedValues
//               visible="false"                UI.Hidden
//               creatable, updatable "false"   Core.Computed (both) or Core.Immutable (updatable)
//   EntityType  label                          Common.Label
//   EntitySet   creatable, updatable,          Capabilities.InsertRestrictions, UpdateRestrictions,
//               deletable (or -path)           DeleteRestrictions
//               searchable (default false)     Capabilities.SearchRestrictions
//               pageable, countable,           Capabilities.TopSupported and SkipSupported,
//               addressable "false"            CountRestrictions, IndexableByKey
//               requires-filter, and its       Capabilities.FilterRestrictions
//               type's filterable,
//               required-in-filter and
//               filter-restriction
//               its type's sortable            Capabilities.SortRestrictions
//
// A term the document's own <Annotations> blocks already set on the same target is left
// out: the block is emitted as it is (see emitV4), and a term may be applied only once.

import type { EntitySet, EntityType, Property } from "./model.ts";

const VOCABULARIES = {
  Common: {
    namespace: "com.sap.vocabularies.Common.v1",
    uri: "https://sap.github.io/odata-vocabularies/vocabularies/Common.xml",
  },
  UI: {
    namespace: "com.sap.vocabularies.UI.v1",
    uri: "https://sap.github.io/odata-vocabularies/vocabularies/UI.xml",
  },
  Core: {
    namespace: "Org.OData.Core.V1",
    uri: "https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Core.V1.xml",
  },
  Capabilities: {
    namespace: "Org.OData.Capabilities.V1",
    uri: "https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Capabilities.V1.xml",
  },
  Measures: {
    namespace: "Org.OData.Measures.V1",
    uri: "https://oasis-tcs.github.io/odata-vocabularies/vocabularies/Org.OData.Measures.V1.xml",
  },
};
type Vocabulary = keyof typeof VOCABULARIES;

// An annotation's value: one of the CSDL expressions the mapping needs
type Value =
  | { String: string }
  | { Bool: boolean }
  | { Path: string }
  | { PropertyPath: string }
  | { Record: [string, Value][] }
  | { Collection: Value[] };

// [vocabulary, term, value]: no value for a tag such as Common.IsCurrency
type Term = [Vocabulary, string, Value?];

// sap:filter-restriction -> Capabilities.FilterExpressionType
const FILTER_EXPRESSIONS: Record<string, string> = {
  "single-value": "SingleValue",
  "multi-value": "MultiValue",
  interval: "SingleRange",
};

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

const indent = (line: string) => `  ${line}`;

// The value as an attribute, for the expressions that can be one
function inline(v: Value): string | undefined {
  if ("String" in v) return ` String="${esc(v.String)}"`;
  if ("Bool" in v) return ` Bool="${v.Bool}"`;
  if ("Path" in v) return ` Path="${esc(v.Path)}"`;
  if ("PropertyPath" in v) return ` PropertyPath="${esc(v.PropertyPath)}"`;
  return undefined;
}

// The value as child elements (a record or collection, or an item of a collection)
function elements(v: Value): string[] {
  if ("Record" in v)
    return [
      "<Record>",
      ...v.Record.flatMap(([p, pv]) =>
        element(`PropertyValue Property="${esc(p)}"`, pv),
      ).map(indent),
      "</Record>",
    ];
  if ("Collection" in v)
    return [
      "<Collection>",
      ...v.Collection.flatMap(elements).map(indent),
      "</Collection>",
    ];
  const [[name, value]] = Object.entries(v);
  return [`<${name}>${esc(value)}</${name}>`];
}

// <Tag attrs/> carrying the value, inline or as children
function element(open: string, v: Value | undefined): string[] {
  if (!v) return [`<${open}/>`];
  const a = inline(v);
  if (a !== undefined) return [`<${open}${a}/>`];
  return [`<${open}>`, ...elements(v).map(indent), `</${open.split(" ")[0]}>`];
}

class SapAnnotations {
  // The alias each vocabulary is written with: the document's own, where it references it
  private aliases: Partial<Record<Vocabulary, string>> = {};
  // The vocabularies the document references, and those used that it doesn't (emitV4
  // adds a reference for each)
  private referenced = new Set<Vocabulary>();
  private missing = new Set<Vocabulary>();
  // "<target> <qualified term>" for each term the document's <Annotations> blocks set
  private existing = new Set<string>();

  constructor(referencesXml: string[], annotationsXml: string[]) {
    const namespaceOf: Record<string, string> = {};
    for (const ref of referencesXml)
      for (const [include] of ref.matchAll(/<(?:\w+:)?Include\b[^>]*>/g)) {
        const namespace = attr(include, "Namespace");
        if (!namespace) continue;
        const alias = attr(include, "Alias") || namespace;
        namespaceOf[alias] = namespace;
        for (const [name, v] of Object.entries(VOCABULARIES))
          if (v.namespace === namespace) {
            this.aliases[name as Vocabulary] ||= alias;
            this.referenced.add(name as Vocabulary);
          }
      }
    for (const name of Object.keys(VOCABULARIES) as Vocabulary[]) {
      if (this.aliases[name]) continue;
      // The usual alias, unless the document gives it to another namespace
      this.aliases[name] = namespaceOf[name]
        ? VOCABULARIES[name].namespace
        : name;
    }

    for (const block of annotationsXml) {
      const target = attr(block, "Target");
      for (const [tag] of block.matchAll(/<Annotation\b[^>]*>/g)) {
        const term = attr(tag, "Term");
        if (!term || attr(tag, "Qualifier")) continue;
        const dot = term.lastIndexOf(".");
        const prefix = term.slice(0, dot);
        this.existing.add(
          `${target} ${namespaceOf[prefix] || prefix}${term.slice(dot)}`,
        );
      }
    }
  }

  // The <edmx:Reference> elements for the vocabularies used that the document lacks
  references(): string[] {
    return [...this.missing].flatMap((name) => {
      const { namespace, uri } = VOCABULARIES[name];
      const alias = this.aliases[name];
      return [
        `<edmx:Reference Uri="${esc(uri)}">`,
        `  <edmx:Include Namespace="${esc(namespace)}"${
          alias === namespace ? "" : ` Alias="${esc(alias)}"`
        }/>`,
        "</edmx:Reference>",
      ];
    });
  }

  // The <Annotation> elements for the terms, less those a block sets on the target
  private render(target: string, terms: Term[]): string[] {
    return terms
      .filter(
        ([vocabulary, term]) =>
          !this.existing.has(
            `${target} ${VOCABULARIES[vocabulary].namespace}.${term}`,
          ),
      )
      .flatMap(([vocabulary, term, value]) => {
        if (!this.referenced.has(vocabulary)) this.missing.add(vocabulary);
        return element(
          `Annotation Term="${esc(`${this.aliases[vocabulary]}.${term}`)}"`,
          value,
        );
      });
  }

  // A property of an entity or complex type; siblings: the type's properties (sap:unit
  // names one of them), target: "<Type>/<Property>"
  property(
    p: Property,
    siblings: Record<string, Property>,
    target: string,
  ): string[] {
    const sap = p.sap;
    const terms: Term[] = [];
    if (p.label) terms.push(["Common", "Label", { String: p.label }]);
    if (sap.heading) terms.push(["Common", "Heading", { String: sap.heading }]);
    if (sap.quickinfo)
      terms.push(["Common", "QuickInfo", { String: sap.quickinfo }]);
    if (sap.text) terms.push(["Common", "Text", { Path: sap.text }]);
    if (sap.unit)
      terms.push([
        "Measures",
        siblings[sap.unit]?.sap.semantics === "currency-code"
          ? "ISOCurrency"
          : "Unit",
        { Path: sap.unit },
      ]);
    if (sap.semantics === "currency-code") terms.push(["Common", "IsCurrency"]);
    if (sap.semantics === "unit-of-measure") terms.push(["Common", "IsUnit"]);
    if (sap["display-format"] === "UpperCase")
      terms.push(["Common", "IsUpperCase"]);
    if (sap["field-control"])
      terms.push(["Common", "FieldControl", { Path: sap["field-control"] }]);
    if (sap["value-list"] === "fixed-values")
      terms.push(["Common", "ValueListWithFixedValues"]);
    if (sap.visible === "false") terms.push(["UI", "Hidden"]);
    if (p.computed || (sap.creatable === "false" && sap.updatable === "false"))
      terms.push(["Core", "Computed"]);
    else if (sap.updatable === "false") terms.push(["Core", "Immutable"]);
    return this.render(target, terms);
  }

  entityType(et: EntityType): string[] {
    const label = et.sap?.label;
    return this.render(
      et.fullName,
      label ? [["Common", "Label", { String: label }]] : [],
    );
  }

  // target: "<Namespace>.<Container>/<EntitySet>"
  entitySet(es: EntitySet, et: EntityType, target: string): string[] {
    const sap = es.sap || {};
    const props = Object.values(et.properties);
    const terms: Term[] = [];
    const restriction = (
      term: string,
      property: string,
      flag: string | undefined,
      path: string | undefined,
    ) => {
      if (path)
        terms.push([
          "Capabilities",
          term,
          { Record: [[property, { Path: path }]] },
        ]);
      else if (flag === "false")
        terms.push([
          "Capabilities",
          term,
          { Record: [[property, { Bool: false }]] },
        ]);
    };
    restriction("InsertRestrictions", "Insertable", sap.creatable, undefined);
    restriction(
      "UpdateRestrictions",
      "Updatable",
      sap.updatable,
      sap["updatable-path"],
    );
    restriction(
      "DeleteRestrictions",
      "Deletable",
      sap.deletable,
      sap["deletable-path"],
    );

    // SAP's default is not searchable; a set without sap: attributes isn't SAP's
    if (Object.keys(sap).length && sap.searchable !== "true")
      terms.push([
        "Capabilities",
        "SearchRestrictions",
        { Record: [["Searchable", { Bool: false }]] },
      ]);
    if (sap.pageable === "false")
      terms.push(
        ["Capabilities", "TopSupported", { Bool: false }],
        ["Capabilities", "SkipSupported", { Bool: false }],
      );
    if (sap.countable === "false")
      terms.push([
        "Capabilities",
        "CountRestrictions",
        { Record: [["Countable", { Bool: false }]] },
      ]);
    if (sap.addressable === "false")
      terms.push(["Capabilities", "IndexableByKey", { Bool: false }]);

    const paths = (names: Property[]): Value => ({
      Collection: names.map((p) => ({ PropertyPath: p.name })),
    });
    const filter: [string, Value][] = [];
    if (sap["requires-filter"] === "true")
      filter.push(["RequiresFilter", { Bool: true }]);
    const required = props.filter(
      (p) => p.sap["required-in-filter"] === "true",
    );
    if (required.length) filter.push(["RequiredProperties", paths(required)]);
    const nonFilterable = props.filter((p) => p.sap.filterable === "false");
    if (nonFilterable.length)
      filter.push(["NonFilterableProperties", paths(nonFilterable)]);
    const restricted = props.filter(
      (p) => FILTER_EXPRESSIONS[p.sap["filter-restriction"]],
    );
    if (restricted.length)
      filter.push([
        "FilterExpressionRestrictions",
        {
          Collection: restricted.map((p) => ({
            Record: [
              ["Property", { PropertyPath: p.name }],
              [
                "AllowedExpressions",
                { String: FILTER_EXPRESSIONS[p.sap["filter-restriction"]] },
              ],
            ],
          })),
        },
      ]);
    if (filter.length)
      terms.push(["Capabilities", "FilterRestrictions", { Record: filter }]);
    const nonSortable = props.filter((p) => p.sap.sortable === "false");
    if (nonSortable.length)
      terms.push([
        "Capabilities",
        "SortRestrictions",
        { Record: [["NonSortableProperties", paths(nonSortable)]] },
      ]);
    return this.render(target, terms);
  }
}

export { SapAnnotations };
