import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { parseMetadata } from "../lib/metadata.ts";
import { emitV4 } from "../lib/emit-v4.ts";

const xml = fs.readFileSync(
  path.join(
    import.meta.dirname,
    "fixtures",
    "SapAnnotationsV2",
    "metadata.xml",
  ),
  "utf8",
);
const v4 = emitV4(parseMetadata(xml));

// The emitted document, every element an array
type El = Record<string, El[] | string>;
const doc = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name, jpath, isLeaf, isAttribute) => !isAttribute,
}).parse(v4) as El;
const children = (el: El, tag: string) => (el[tag] || []) as El[];
const schema = children(
  children(children(doc, "edmx:Edmx")[0], "edmx:DataServices")[0],
  "Schema",
)[0];
const byName = (els: El[], name: string) => {
  const el = els.find((e) => e.Name === name);
  assert.ok(el, `${name} is emitted`);
  return el;
};
const entityType = (name: string) =>
  byName(children(schema, "EntityType"), name);
const entitySet = (name: string) =>
  byName(children(children(schema, "EntityContainer")[0], "EntitySet"), name);

// The element's annotations by term
function annotations(el: El): Record<string, El> {
  return Object.fromEntries(
    children(el, "Annotation").map((a) => [a.Term as string, a]),
  );
}
const ofProperty = (type: string, prop: string) =>
  annotations(byName(children(entityType(type), "Property"), prop));

// A <Record>'s property values: their value attribute, or the PropertyPaths of a collection
function record(annotation: El): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pv of children(
    children(annotation, "Record")[0],
    "PropertyValue",
  )) {
    const { Property, ...value } = pv;
    const collection = children(pv, "Collection")[0];
    out[Property as string] = collection
      ? collection.PropertyPath
        ? children(collection, "PropertyPath").map((p) => p["#text"] ?? p)
        : children(collection, "Record").map((r) =>
            Object.fromEntries(
              children(r, "PropertyValue").map((v) => {
                const { Property: name, ...rest } = v;
                return [name, Object.values(rest)[0]];
              }),
            ),
          )
      : Object.values(value)[0];
  }
  return out;
}

describe("emitV4 turns a V2 document's sap: attributes into V4 annotations", () => {
  it("writes terms with the document's own alias, and references the vocabularies it lacks", () => {
    assert.ok(ofProperty("Product", "Name")["SAP__common.Label"]);
    assert.ok(!ofProperty("Product", "Name")["Common.Label"]);
    const includes = children(
      doc["edmx:Edmx"][0] as El,
      "edmx:Reference",
    ).flatMap((r) => children(r, "edmx:Include"));
    assert.deepEqual(includes.map((i) => [i.Namespace, i.Alias]).sort(), [
      ["Org.OData.Capabilities.V1", "Capabilities"],
      ["Org.OData.Core.V1", "Core"],
      ["Org.OData.Measures.V1", "Measures"],
      ["com.sap.vocabularies.Common.v1", "SAP__common"],
      ["com.sap.vocabularies.UI.v1", "UI"],
    ]);
  });

  it("labels, headings and quick info", () => {
    const name = ofProperty("Product", "Name");
    assert.equal(name["SAP__common.Label"].String, "Name");
    assert.equal(name["SAP__common.Heading"].String, "Product name");
    assert.equal(name["SAP__common.QuickInfo"].String, "The product's name");
    assert.equal(
      annotations(entityType("Product"))["SAP__common.Label"].String,
      "Product",
    );
  });

  it("units and currencies: Measures.ISOCurrency for a currency code, Measures.Unit otherwise", () => {
    assert.equal(
      ofProperty("Product", "Price")["Measures.ISOCurrency"].Path,
      "Currency",
    );
    assert.equal(
      ofProperty("Product", "Weight")["Measures.Unit"].Path,
      "WeightUnit",
    );
    const currency = ofProperty("Product", "Currency");
    assert.ok(currency["SAP__common.IsCurrency"]);
    assert.ok(currency["SAP__common.IsUpperCase"]);
    assert.ok(currency["SAP__common.ValueListWithFixedValues"]);
    assert.ok(ofProperty("Product", "WeightUnit")["SAP__common.IsUnit"]);
  });

  it("field control, visibility, and what the client may set", () => {
    assert.equal(
      ofProperty("Product", "Status")["SAP__common.FieldControl"].Path,
      "StatusFC",
    );
    assert.ok(ofProperty("Product", "Note")["UI.Hidden"]);
    assert.ok(ofProperty("Product", "ID")["Core.Computed"]);
    assert.ok(ofProperty("Product", "CreatedAt")["Core.Immutable"]);
    assert.ok(!ofProperty("Product", "CreatedAt")["Core.Computed"]);
  });

  it("leaves out a term the document's <Annotations> blocks already set on the target", () => {
    assert.ok(!ofProperty("Product", "CategoryID")["SAP__common.Text"]);
    assert.equal(
      (v4.match(/<Annotation Term="SAP__common.Text"/g) || []).length,
      1,
    );
  });

  it("entity set restrictions", () => {
    const products = annotations(entitySet("Products"));
    assert.deepEqual(record(products["Capabilities.DeleteRestrictions"]), {
      Deletable: "false",
    });
    assert.deepEqual(record(products["Capabilities.UpdateRestrictions"]), {
      Updatable: "Editable",
    });
    assert.ok(!products["Capabilities.InsertRestrictions"]);
    assert.ok(!products["Capabilities.SearchRestrictions"]); // sap:searchable="true"
    assert.deepEqual(record(products["Capabilities.FilterRestrictions"]), {
      RequiresFilter: "true",
      RequiredProperties: ["CategoryID"],
      NonFilterableProperties: ["Note"],
      FilterExpressionRestrictions: [
        { Property: "Name", AllowedExpressions: "MultiValue" },
      ],
    });
    assert.deepEqual(record(products["Capabilities.SortRestrictions"]), {
      NonSortableProperties: ["Note"],
    });

    const logs = annotations(entitySet("Logs"));
    assert.deepEqual(record(logs["Capabilities.InsertRestrictions"]), {
      Insertable: "false",
    });
    // SAP's default: not searchable
    assert.deepEqual(record(logs["Capabilities.SearchRestrictions"]), {
      Searchable: "false",
    });
    assert.equal(logs["Capabilities.TopSupported"].Bool, "false");
    assert.equal(logs["Capabilities.SkipSupported"].Bool, "false");
    assert.deepEqual(record(logs["Capabilities.CountRestrictions"]), {
      Countable: "false",
    });
    assert.equal(logs["Capabilities.IndexableByKey"].Bool, "false");
  });

  it("nothing for a set or type without sap: attributes", () => {
    assert.deepEqual(annotations(entitySet("Plains")), {});
    assert.deepEqual(annotations(entityType("Plain")), {});
  });

  it("the emitted document parses back, with the computed key", () => {
    const back = parseMetadata(v4);
    assert.equal(back.sourceVersion, "4.0");
    assert.equal(
      back.entityTypes["ZANNO_SRV.Product"].properties.ID.computed,
      true,
    );
  });
});

describe("emitV4 names a V2 document's operations on an entity as the V4 bound actions", () => {
  // RAP's V2 metadata, plus a block on a function import and one on its parameter
  const draftXml = fs
    .readFileSync(
      path.join(import.meta.dirname, "fixtures", "DraftSrvV2", "metadata.xml"),
      "utf8",
    )
    .replace(
      "<Annotations ",
      `<Annotations Target="TravelService.TravelService_Entities/TravelEdit" xmlns="http://docs.oasis-open.org/odata/ns/edm">
        <Annotation Term="Common.Label" String="Edit"/>
      </Annotations>
      <Annotations Target="TravelService.TravelService_Entities/TravelEdit/PreserveChanges" xmlns="http://docs.oasis-open.org/odata/ns/edm">
        <Annotation Term="Common.Label" String="Keep changes"/>
      </Annotations>
      <Annotations `,
    );
  const out = emitV4(parseMetadata(draftXml));

  it("in a draft annotation, which Fiori Elements V4 calls the actions by", () => {
    assert.match(
      out,
      /<PropertyValue Property="ActivationAction" String="TravelService.TravelActivate"\/>/,
    );
    assert.match(
      out,
      /<PropertyValue Property="EditAction" String="TravelService.TravelEdit"\/>/,
    );
    assert.match(
      out,
      /<PropertyValue Property="PreparationAction" String="TravelService.BookingPrepare"\/>/,
    );
    assert.doesNotMatch(out, /String="TravelService.TravelService_Entities\//);
  });

  it("in a block's target: the action's overload, and its parameter", () => {
    assert.match(
      out,
      /<Annotations Target="TravelService.TravelEdit\(TravelService.TravelType\)" /,
    );
    assert.match(
      out,
      /<Annotations Target="TravelService.TravelEdit\(TravelService.TravelType\)\/PreserveChanges" /,
    );
    // An entity set's target stays as it is
    assert.match(
      out,
      /<Annotations Target="TravelService.TravelService_Entities\/Travel" /,
    );
  });
});
