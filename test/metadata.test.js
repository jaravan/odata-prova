import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseMetadata, emitV2, emitV4 } from "../lib/metadata.ts";
import { PO_MODEL, SALES_MODEL } from "./helpers.js";

const v2Xml = fs.readFileSync(path.join(PO_MODEL, "metadata.xml"), "utf8");
const v4Xml = fs.readFileSync(path.join(SALES_MODEL, "metadata.xml"), "utf8");

// The parts of a model that must survive a round trip through the other flavour.
function shape(model, { withCascade = true, withV2Type = true } = {}) {
  const types = {};
  for (const et of Object.values(model.entityTypes)) {
    types[et.fullName] = {
      keys: et.keys,
      properties: Object.fromEntries(
        Object.values(et.properties).map((p) => [
          p.name,
          {
            type: p.type,
            nullable: p.nullable,
            label: p.label,
            ...(withV2Type ? { v2Type: p.v2Type } : {}),
          },
        ]),
      ),
      navigations: Object.fromEntries(
        Object.values(et.navigations).map((n) => [
          n.name,
          {
            targetSet: n.targetSet,
            targetType: n.targetType,
            isCollection: n.isCollection,
            join: n.join,
            dependentSide: n.dependentSide,
            partner: n.partner,
            ...(withCascade ? { cascadeDelete: n.cascadeDelete } : {}),
          },
        ]),
      ),
    };
  }
  return {
    sets: Object.fromEntries(
      Object.values(model.entitySets).map((s) => [s.name, s.entityType]),
    ),
    types,
  };
}

describe("parseMetadata (V2 document)", () => {
  const model = parseMetadata(v2Xml);
  it("detects the version and normalises types", () => {
    assert.equal(model.sourceVersion, "2.0");
    const po = model.entityTypes["com.example.po.PurchaseOrder"];
    assert.deepEqual(po.keys, ["PurchaseOrderId"]);
    assert.equal(po.properties.OrderDate.type, "Edm.Date"); // sap:display-format="Date"
    assert.equal(po.properties.OrderDate.v2Type, "Edm.DateTime");
    assert.equal(po.properties.TotalAmount.type, "Edm.Decimal");
  });
  it("resolves navigations through the association's ReferentialConstraint", () => {
    const po = model.entityTypes["com.example.po.PurchaseOrder"];
    const item = model.entityTypes["com.example.po.PurchaseOrderItem"];
    assert.deepEqual(po.navigations.Items, {
      name: "Items",
      targetSet: "PurchaseOrderItemSet",
      targetType: "com.example.po.PurchaseOrderItem",
      isCollection: true,
      dependentSide: "target",
      join: [["PurchaseOrderId", "PurchaseOrderId"]],
      cascadeDelete: true,
      partner: "PurchaseOrder",
    });
    assert.equal(item.navigations.PurchaseOrder.isCollection, false);
    assert.equal(item.navigations.PurchaseOrder.dependentSide, "source");
    assert.equal(item.navigations.PurchaseOrder.cascadeDelete, false);
    assert.equal(item.navigations.PurchaseOrder.partner, "Items");
  });
  it("falls back to same-named keys when there is no ReferentialConstraint", () => {
    const stripped = v2Xml.replace(
      /<ReferentialConstraint>[\s\S]*?<\/ReferentialConstraint>/,
      "",
    );
    const m = parseMetadata(stripped);
    assert.deepEqual(
      m.entityTypes["com.example.po.PurchaseOrder"].navigations.Items.join,
      [["PurchaseOrderId", "PurchaseOrderId"]],
    );
    assert.equal(
      m.entityTypes["com.example.po.PurchaseOrder"].navigations.Items
        .cascadeDelete,
      true,
    );
  });
  it('maps Edm.DateTime without sap:display-format="Date" to Edm.DateTimeOffset', () => {
    const withTime = v2Xml.replace(
      ' sap:display-format="Date"',
      ' sap:label="Order date"',
    );
    const p =
      parseMetadata(withTime).entityTypes["com.example.po.PurchaseOrder"]
        .properties.OrderDate;
    assert.equal(p.type, "Edm.DateTimeOffset");
    assert.equal(p.v2Type, "Edm.DateTime");
    assert.equal(p.label, "Order date");
  });
});

describe("parseMetadata (V4 document, CAP style)", () => {
  const model = parseMetadata(v4Xml);
  it("detects the version and keeps V4 types", () => {
    assert.equal(model.sourceVersion, "4.0");
    const o = model.entityTypes["SalesSrv.Orders"];
    assert.equal(o.properties.ID.type, "Edm.Guid");
    assert.equal(o.properties.OrderDate.type, "Edm.Date");
    assert.equal(o.properties.OrderDate.v2Type, "Edm.DateTime");
    assert.equal(o.properties.DeliveryTime.v2Type, "Edm.Time");
  });
  it("resolves navigations from the inline ReferentialConstraint, Partner and bindings", () => {
    const o = model.entityTypes["SalesSrv.Orders"];
    const i = model.entityTypes["SalesSrv.Items"];
    assert.deepEqual(i.navigations.Order.join, [["Order_ID", "ID"]]);
    assert.equal(i.navigations.Order.dependentSide, "source");
    assert.equal(i.navigations.Order.targetSet, "Orders");
    assert.deepEqual(o.navigations.Items.join, [["ID", "Order_ID"]]);
    assert.equal(o.navigations.Items.isCollection, true);
    assert.equal(o.navigations.Items.partner, "Order");
  });
  it("honours OnDelete Cascade even though the item key does not contain the foreign key", () => {
    assert.equal(
      model.entityTypes["SalesSrv.Orders"].navigations.Items.cascadeDelete,
      true,
    );
  });
  it("keeps references and annotation blocks for re-emission", () => {
    assert.equal(model.referencesXml.length, 1);
    assert.match(model.annotationsXml[0], /Common\.Label/);
  });
});

describe("EDMX round trips", () => {
  it("V2 -> emitV4 -> parse gives the same model (V4 has no Edm.DateTime, so v2Type is not compared)", () => {
    const original = parseMetadata(v2Xml);
    const back = parseMetadata(emitV4(original));
    assert.equal(back.sourceVersion, "4.0");
    assert.deepEqual(
      shape(back, { withV2Type: false }),
      shape(original, { withV2Type: false }),
    );
    assert.equal(
      back.entityTypes["com.example.po.PurchaseOrder"].properties.OrderDate
        .v2Type,
      "Edm.DateTime",
    ); // from Edm.Date
  });
  it("V4 -> emitV2 -> parse gives the same model (V2 has no OnDelete, so cascade is not compared)", () => {
    const original = parseMetadata(v4Xml);
    const v2 = emitV2(original);
    assert.match(v2, /m:DataServiceVersion="2.0"/);
    assert.match(v2, /<Association Name="Orders_Items">/);
    assert.match(v2, /Type="Edm.DateTime" sap:display-format="Date"/);
    assert.match(v2, /<Annotations Target="SalesSrv.Orders\/OrderNo">/);
    assert.match(v2, /<edmx:Reference Uri=/);
    const back = parseMetadata(v2);
    assert.equal(back.sourceVersion, "2.0");
    assert.deepEqual(
      shape(back, { withCascade: false }),
      shape(original, { withCascade: false }),
    );
  });
  it("emitV4 turns sap:label into Common.Label and adds the vocabulary reference", () => {
    const withLabel = v2Xml
      .replace(
        'xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"',
        'xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:sap="http://www.sap.com/Protocols/SAPData"',
      )
      .replace(
        '<Property Name="Supplier" Type="Edm.String" Nullable="false" MaxLength="100"/>',
        '<Property Name="Supplier" Type="Edm.String" Nullable="false" MaxLength="100" sap:label="Supplier &amp; Co"/>',
      );
    const v4 = emitV4(parseMetadata(withLabel));
    assert.match(
      v4,
      /<Annotation Term="Common.Label" String="Supplier &amp; Co"\/>/,
    );
    assert.match(v4, /Namespace="com.sap.vocabularies.Common.v1"/);
  });
});

describe("parseMetadata (what `cds compile --to edmx` actually emits)", () => {
  // Generated from ../po-cap-service: no Partner attributes (unmanaged association), a
  // schema-level <Annotation Term="Core.Links">, Nullable after MaxLength, Edm.Date.
  const model = parseMetadata(
    fs.readFileSync(
      path.join(import.meta.dirname, "fixtures", "cap", "metadata.xml"),
      "utf8",
    ),
  );
  it("infers the parent -> children join from the child's constraint without a Partner", () => {
    const po = model.entityTypes["PurchaseOrderSrv.PurchaseOrderSet"];
    assert.deepEqual(po.navigations.Items.join, [
      ["PurchaseOrderId", "PurchaseOrderId"],
    ]);
    assert.equal(po.navigations.Items.dependentSide, "target");
    assert.equal(po.navigations.Items.cascadeDelete, true);
    assert.equal(po.navigations.Items.partner, "PurchaseOrder");
    assert.equal(po.properties.OrderDate.type, "Edm.Date");
  });
  it("emits a V2 document with one shared association", () => {
    const v2 = emitV2(model);
    assert.equal((v2.match(/<Association Name=/g) || []).length, 1);
    assert.match(
      v2,
      /Relationship="PurchaseOrderSrv.PurchaseOrderSet_Items" FromRole="FromRole_PurchaseOrderSet_Items" ToRole="ToRole_PurchaseOrderSet_Items"/,
    );
    assert.match(
      v2,
      /Relationship="PurchaseOrderSrv.PurchaseOrderSet_Items" FromRole="ToRole_PurchaseOrderSet_Items" ToRole="FromRole_PurchaseOrderSet_Items"/,
    );
    assert.match(
      v2,
      /<Association Name="PurchaseOrderSet_Items">\s*<End Role="FromRole_PurchaseOrderSet_Items" Type="PurchaseOrderSrv.PurchaseOrderSet" Multiplicity="1"\/>\s*<End Role="ToRole_PurchaseOrderSet_Items" Type="PurchaseOrderSrv.PurchaseOrderItemSet" Multiplicity="\*"\/>/,
    );
  });
});
