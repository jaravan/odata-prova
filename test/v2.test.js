import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, send, ORDER, ITEM } from "./helpers.js";

describe("OData V2 protocol", () => {
  let s, v2;
  before(async () => {
    s = await start();
    v2 = s.v2;
  });
  after(() => s.close());

  it("service document, $metadata and headers", async () => {
    const doc = await get(`${v2}/`);
    assert.equal(doc.status, 200);
    assert.equal(doc.headers.get("dataserviceversion"), "2.0");
    assert.deepEqual(doc.body.d.EntitySets, [
      "PurchaseOrderSet",
      "PurchaseOrderItemSet",
    ]);
    const md = await get(`${v2}/$metadata`);
    assert.match(md.headers.get("content-type"), /application\/xml/);
    assert.match(md.body, /m:DataServiceVersion="2.0"/);
    assert.match(md.body, /<Association Name="PurchaseOrder_Items">/); // the original file, verbatim
  });

  it("collection with $filter, $orderby, $top, $skip, $inlinecount", async () => {
    const r = await get(
      `${v2}/PurchaseOrderSet?$filter=Status eq 'Open' or Status eq 'Approved'&$orderby=TotalAmount desc&$top=1&$skip=1&$inlinecount=allpages`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.d.__count, "3");
    assert.equal(r.body.d.results.length, 1);
    const e = r.body.d.results[0];
    assert.equal(e.__metadata.type, "com.example.po.PurchaseOrder");
    assert.match(
      e.__metadata.uri,
      /\/odata\/v2\/T\/PurchaseOrderSet\('45000000\d\d'\)$/,
    );
    assert.match(e.OrderDate, /^\/Date\(\d+\)\/$/);
    assert.equal(e.TotalAmount, "12500.00"); // Decimal stays a string, verbatim
    assert.deepEqual(e.Items, {
      __deferred: { uri: `${e.__metadata.uri}/Items` },
    });
  });

  it("datetime literal in $filter", async () => {
    const r = await get(
      `${v2}/PurchaseOrderSet?$filter=OrderDate ge datetime'2025-02-01T00:00:00'&$select=PurchaseOrderId`,
    );
    assert.equal(r.body.d.results.length, 4);
    assert.deepEqual(Object.keys(r.body.d.results[0]), [
      "__metadata",
      "PurchaseOrderId",
    ]);
  });

  it("$expand with nested $select, and $count", async () => {
    const r = await get(
      `${v2}/PurchaseOrderSet('4500000001')?$expand=Items/PurchaseOrder&$select=PurchaseOrderId,Items/Material,Items/PurchaseOrder/Supplier`,
    );
    assert.equal(r.status, 200);
    const d = r.body.d;
    assert.equal(d.Items.results.length, 2);
    assert.deepEqual(Object.keys(d.Items.results[0]).sort(), [
      "Material",
      "PurchaseOrder",
      "__metadata",
    ]);
    assert.equal(
      d.Items.results[0].PurchaseOrder.Supplier,
      "Acme Components Ltd",
    );
    const c = await get(`${v2}/PurchaseOrderSet('4500000001')/Items/$count`);
    assert.equal(c.body, "2");
  });

  it("composite keys, navigation, property and $value", async () => {
    const item = await get(
      `${v2}/PurchaseOrderItemSet(PurchaseOrderId='4500000001',ItemPosition='0002')`,
    );
    assert.equal(item.body.d.Material, "MAT-1002");
    const parent = await get(
      `${v2}/PurchaseOrderItemSet(PurchaseOrderId='4500000001',ItemPosition='0002')/PurchaseOrder`,
    );
    assert.equal(parent.body.d.PurchaseOrderId, "4500000001");
    const prop = await get(`${v2}/PurchaseOrderSet('4500000001')/Supplier`);
    assert.deepEqual(prop.body, { d: { Supplier: "Acme Components Ltd" } });
    const raw = await get(
      `${v2}/PurchaseOrderSet('4500000001')/Supplier/$value`,
    );
    assert.equal(raw.body, "Acme Components Ltd");
    const missing = await get(`${v2}/PurchaseOrderSet('nope')`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.message.value, "PurchaseOrder not found");
  });

  it("deep insert, MERGE, PUT (replace), DELETE with cascade", async () => {
    const created = await send("POST", `${v2}/PurchaseOrderSet`, {
      PurchaseOrderId: "4500000099",
      Supplier: "New Co",
      CompanyCode: "1000",
      OrderDate: "/Date(1735689600000)/",
      Status: "Open",
      Currency: "EUR",
      TotalAmount: "1.00",
      Items: {
        results: [
          {
            ItemPosition: "0001",
            Material: "X",
            Description: "x",
            Quantity: "1.000",
            Unit: "EA",
            NetPrice: "1.00",
            Currency: "EUR",
          },
        ],
      },
    });
    assert.equal(created.status, 201);
    assert.equal(
      created.headers.get("location"),
      "/odata/v2/T/PurchaseOrderSet('4500000099')",
    );
    assert.equal(created.body.d.OrderDate, "/Date(1735689600000)/");
    const items = await get(`${v2}/PurchaseOrderSet('4500000099')/Items`);
    assert.equal(items.body.d.results[0].PurchaseOrderId, "4500000099"); // foreign key filled in

    const merged = await send("MERGE", `${v2}/PurchaseOrderSet('4500000099')`, {
      Status: "Approved",
      PurchaseOrderId: "hacked",
    });
    assert.equal(merged.status, 204);
    let po = await get(`${v2}/PurchaseOrderSet('4500000099')`);
    assert.equal(po.body.d.Status, "Approved");
    assert.equal(po.body.d.Supplier, "New Co"); // merge keeps the rest
    assert.equal(po.body.d.PurchaseOrderId, "4500000099"); // keys are immutable

    await send("PUT", `${v2}/PurchaseOrderSet('4500000099')`, {
      ...ORDER,
      Supplier: "Replaced",
      OrderDate: "/Date(1735689600000)/",
    });
    po = await get(`${v2}/PurchaseOrderSet('4500000099')`);
    assert.equal(po.body.d.Supplier, "Replaced");
    assert.equal(po.body.d.Status, "Open"); // PUT replaces

    const dup = await send("POST", `${v2}/PurchaseOrderSet`, {
      ...ORDER,
      PurchaseOrderId: "4500000099",
      OrderDate: "/Date(1735689600000)/",
    });
    assert.equal(dup.status, 409);

    const del = await send("DELETE", `${v2}/PurchaseOrderSet('4500000099')`);
    assert.equal(del.status, 204);
    assert.equal(
      (await get(`${v2}/PurchaseOrderSet('4500000099')`)).status,
      404,
    );
    const orphan = await get(
      `${v2}/PurchaseOrderItemSet?$filter=PurchaseOrderId eq '4500000099'`,
    );
    assert.equal(orphan.body.d.results.length, 0);
  });

  it("POST to a navigation fills the foreign key", async () => {
    const r = await send("POST", `${v2}/PurchaseOrderSet('4500000002')/Items`, {
      ...ITEM,
      ItemPosition: "0099",
      Material: "Y",
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.d.PurchaseOrderId, "4500000002");
    await send(
      "DELETE",
      `${v2}/PurchaseOrderItemSet(PurchaseOrderId='4500000002',ItemPosition='0099')`,
    );
  });

  it("CSRF token handshake and bad requests", async () => {
    const r = await get(`${v2}/`, { "x-csrf-token": "Fetch" });
    assert.equal(r.headers.get("x-csrf-token"), "mock-csrf-token");
    const bad = await get(`${v2}/PurchaseOrderSet?$filter=Nope eq 1`);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message.value, /Unknown property Nope/);
    assert.equal((await get(`${v2}/Nope`)).status, 404);
  });

  it("HEAD is answered like GET, without a body (UI5 uses it for the CSRF token)", async () => {
    const head = (url, headers) => fetch(url, { method: "HEAD", headers });
    for (const root of [`${v2}/`, `${s.v4}/`]) {
      const r = await head(root, { "x-csrf-token": "Fetch" });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-csrf-token"), "mock-csrf-token");
      assert.equal(await r.text(), "");
    }
    assert.equal(
      (await head(`${v2}/PurchaseOrderSet('4500000001')`)).status,
      200,
    );
    assert.equal((await head(`${v2}/Nope`)).status, 404);
  });
});
