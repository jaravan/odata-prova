const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, get, send, SALES_MODEL } = require("./helpers");

const IEEE = { accept: "application/json;odata.metadata=minimal;IEEE754Compatible=true" };

describe("OData V4 protocol (model loaded from a V2 document)", () => {
  let s, v4;
  before(async () => { s = await start(); v4 = s.v4; });
  after(() => s.close());

  it("service document, generated $metadata and headers", async () => {
    const doc = await get(`${v4}/`);
    assert.equal(doc.status, 200);
    assert.equal(doc.headers.get("odata-version"), "4.0");
    assert.match(doc.headers.get("content-type"), /odata\.metadata=minimal/);
    assert.equal(doc.body["@odata.context"], "/odata/v4/T/$metadata");
    assert.deepEqual(doc.body.value[0], { name: "PurchaseOrderSet", kind: "EntitySet", url: "PurchaseOrderSet" });
    const md = await get(`${v4}/$metadata`);
    assert.match(md.body, /<edmx:Edmx Version="4.0"/);
    assert.match(md.body, /<NavigationProperty Name="Items" Type="Collection\(com.example.po.PurchaseOrderItem\)" Partner="PurchaseOrder">/);
    assert.match(md.body, /<NavigationPropertyBinding Path="Items" Target="PurchaseOrderItemSet"\/>/);
  });

  it("collection with $count, $filter (bare date, contains, in), $orderby, paging", async () => {
    const r = await get(`${v4}/PurchaseOrderSet?$count=true&$filter=OrderDate ge 2025-02-01 and contains(Supplier,'e') and Status in ('Open','Approved')&$orderby=TotalAmount desc&$top=2&$skip=0&$select=PurchaseOrderId,TotalAmount`);
    assert.equal(r.status, 200);
    assert.equal(r.body["@odata.context"], "/odata/v4/T/$metadata#PurchaseOrderSet");
    assert.equal(typeof r.body["@odata.count"], "number");
    assert.ok(r.body.value.length <= 2);
    assert.deepEqual(Object.keys(r.body.value[0]), ["PurchaseOrderId", "TotalAmount"]);
    assert.equal(typeof r.body.value[0].TotalAmount, "number"); // no IEEE754Compatible -> numbers
  });

  it("IEEE754Compatible=true keeps Decimal/Int64 as strings (what UI5 asks for)", async () => {
    const r = await get(`${v4}/PurchaseOrderSet('4500000001')`, IEEE);
    assert.equal(r.body.TotalAmount, "12500.00");
    assert.match(r.headers.get("content-type"), /IEEE754Compatible=true/);
    assert.equal(r.body["@odata.context"], "/odata/v4/T/$metadata#PurchaseOrderSet/$entity");
    assert.equal(r.body.OrderDate, "2025-01-20T00:00:00.000Z");
    assert.equal("Items" in r.body, false); // no deferred stubs in V4
  });

  it("$expand with nested options and $count", async () => {
    const r = await get(`${v4}/PurchaseOrderSet('4500000001')?$expand=Items($select=Material,NetPrice;$orderby=NetPrice desc;$top=1;$count=true;$expand=PurchaseOrder($select=Supplier))&$select=PurchaseOrderId`);
    assert.equal(r.status, 200);
    assert.equal(r.body["Items@odata.count"], 2);
    assert.equal(r.body.Items.length, 1);
    assert.deepEqual(r.body.Items[0], { Material: "MAT-1002", NetPrice: 22.5, PurchaseOrder: { Supplier: "Acme Components Ltd" } });
    const bad = await get(`${v4}/PurchaseOrderSet?$expand=Nope`);
    assert.equal(bad.status, 400);
    assert.equal(typeof bad.body.error.message, "string");
  });

  it("$search across string properties", async () => {
    const r = await get(`${v4}/PurchaseOrderSet?$search=nordic&$select=Supplier`);
    assert.deepEqual(r.body.value, [{ Supplier: "Nordic Steel AB" }]);
  });

  it("navigation, property, $value, $count and null single-valued navigation", async () => {
    const parent = await get(`${v4}/PurchaseOrderItemSet(PurchaseOrderId='4500000001',ItemPosition='0002')/PurchaseOrder?$select=Supplier`);
    assert.deepEqual(parent.body, { "@odata.context": "/odata/v4/T/$metadata#PurchaseOrderSet/$entity", Supplier: "Acme Components Ltd" });
    const prop = await get(`${v4}/PurchaseOrderSet('4500000001')/Supplier`);
    assert.deepEqual(prop.body, { "@odata.context": "/odata/v4/T/$metadata#PurchaseOrderSet('4500000001')/Supplier", value: "Acme Components Ltd" });
    assert.equal((await get(`${v4}/PurchaseOrderSet('4500000001')/Supplier/$value`)).body, "Acme Components Ltd");
    assert.equal((await get(`${v4}/PurchaseOrderSet/$count?$filter=Status eq 'Open'`)).body, "2");
    // An item whose order does not exist: single-valued navigation resolves to nothing -> 204.
    await send("POST", `${v4}/PurchaseOrderItemSet`, { PurchaseOrderId: "0000000000", ItemPosition: "0001" });
    assert.equal((await get(`${v4}/PurchaseOrderItemSet(PurchaseOrderId='0000000000',ItemPosition='0001')/PurchaseOrder`)).status, 204);
    await send("DELETE", `${v4}/PurchaseOrderItemSet(PurchaseOrderId='0000000000',ItemPosition='0001')`);
  });

  it("POST with deep insert, PATCH with Prefer, PUT, DELETE cascade", async () => {
    const created = await send("POST", `${v4}/PurchaseOrderSet`, {
      PurchaseOrderId: "4500000098", Supplier: "V4 Co", CompanyCode: "1000", OrderDate: "2025-06-01T00:00:00Z",
      Status: "Open", Currency: "EUR", TotalAmount: "5.00",
      Items: [{ ItemPosition: "0001", Material: "X", Description: "x", Quantity: "1.000", Unit: "EA", NetPrice: "5.00", Currency: "EUR" }]
    }, IEEE);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("location"), "/odata/v4/T/PurchaseOrderSet('4500000098')");
    assert.equal(created.body.TotalAmount, "5.00");
    const items = await get(`${v4}/PurchaseOrderSet('4500000098')/Items`);
    assert.equal(items.body.value.length, 1);

    const minimal = await send("PATCH", `${v4}/PurchaseOrderSet('4500000098')`, { Status: "Approved" }, { prefer: "return=minimal" });
    assert.equal(minimal.status, 204);
    assert.equal(minimal.headers.get("preference-applied"), "return=minimal");
    const repr = await send("PATCH", `${v4}/PurchaseOrderSet('4500000098')`, { Status: "Closed" }, { prefer: "return=representation" });
    assert.equal(repr.status, 200);
    assert.equal(repr.body.Status, "Closed");
    assert.equal(repr.body.Supplier, "V4 Co");

    const minimalPost = await send("POST", `${v4}/PurchaseOrderSet('4500000098')/Items`, { ItemPosition: "0002" }, { prefer: "return=minimal" });
    assert.equal(minimalPost.status, 204);
    assert.equal(minimalPost.headers.get("location"), "/odata/v4/T/PurchaseOrderItemSet(PurchaseOrderId='4500000098',ItemPosition='0002')");

    await send("PUT", `${v4}/PurchaseOrderSet('4500000098')`, { Supplier: "Only this" });
    const po = await get(`${v4}/PurchaseOrderSet('4500000098')`);
    assert.equal(po.body.Status, null);

    assert.equal((await send("DELETE", `${v4}/PurchaseOrderSet('4500000098')`)).status, 204);
    assert.equal((await get(`${v4}/PurchaseOrderItemSet/$count?$filter=PurchaseOrderId eq '4500000098'`)).body, "0");
  });
});

describe("OData V4 protocol (model loaded from a V4 document with Guid/Date/TimeOfDay)", () => {
  let s, v4, v2;
  before(async () => { s = await start(SALES_MODEL); v4 = s.v4; v2 = s.v2; });
  after(() => s.close());

  it("serves the V4 document verbatim and a generated V2 one", async () => {
    const md4 = await get(`${v4}/$metadata`);
    assert.match(md4.body, /<Annotations Target="SalesSrv.Orders\/OrderNo">/);
    const md2 = await get(`${v2}/$metadata`);
    assert.match(md2.body, /<Association Name="Orders_Items">/);
    assert.match(md2.body, /<Property Name="ID" Type="Edm.Guid" Nullable="false"\/>/);
  });

  it("bare Guid keys and date/time types on the V4 wire", async () => {
    const r = await get(`${v4}/Orders(11111111-1111-1111-1111-111111111111)?$expand=Items($select=Product)`);
    assert.equal(r.status, 200);
    assert.equal(r.body.OrderDate, "2025-03-01");
    assert.equal(r.body.DeliveryTime, "10:30:00");
    assert.equal(r.body.CreatedAt, "2025-03-01T08:15:00.000Z");
    assert.equal(r.body.Total, 100.5);
    assert.equal(r.body.Qty, 3);
    assert.equal(r.body.Closed, false);
    assert.equal(r.body.Items.length, 2);
    const f = await get(`${v4}/Orders?$filter=OrderDate eq 2025-03-15 and DeliveryTime ge 12:00:00&$select=OrderNo`);
    assert.deepEqual(f.body.value, [{ OrderNo: "SO-2" }]);
    const byGuid = await get(`${v4}/Items?$filter=Order_ID eq 22222222-2222-2222-2222-222222222222&$select=Product`);
    assert.deepEqual(byGuid.body.value, [{ Product: "Gizmo" }]);
  });

  it("the same entity on the V2 wire: guid'' keys, /Date()/ and PT..S", async () => {
    const r = await get(`${v2}/Orders(guid'11111111-1111-1111-1111-111111111111')`);
    assert.equal(r.status, 200);
    assert.equal(r.body.d.__metadata.uri, "/odata/v2/T/Orders(guid'11111111-1111-1111-1111-111111111111')");
    assert.equal(r.body.d.OrderDate, `/Date(${Date.UTC(2025, 2, 1)})/`);
    assert.equal(r.body.d.DeliveryTime, "PT10H30M00S");
    assert.equal(r.body.d.CreatedAt, `/Date(${Date.UTC(2025, 2, 1, 8, 15)}+0000)/`);
    assert.equal(r.body.d.Total, "100.50");
    const f = await get(`${v2}/Orders?$filter=OrderDate eq datetime'2025-03-15T00:00:00'&$select=OrderNo`);
    assert.equal(f.body.d.results[0].OrderNo, "SO-2");
  });

  it("OnDelete Cascade from the V4 document is honoured on both protocols", async () => {
    assert.equal((await get(`${v4}/Items/$count`)).body, "3");
    assert.equal((await send("DELETE", `${v2}/Orders(guid'22222222-2222-2222-2222-222222222222')`)).status, 204);
    assert.equal((await get(`${v4}/Items/$count`)).body, "2");
  });
});
