import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";

const item = (pos: string) => ({
  ItemPosition: pos,
  Material: "X",
  Description: "x",
  Quantity: "1.000",
  Unit: "EA",
  NetPrice: "1.00",
  Currency: "EUR",
});
// V4 sends the items as an array, V2 wraps them in { results }
const order = (id: string, items: object[] | { results: object[] }) => ({
  PurchaseOrderId: id,
  Supplier: "S",
  CompanyCode: "1000",
  OrderDate: "2025-01-01",
  Status: "New",
  Currency: "EUR",
  TotalAmount: "1.00",
  Items: items,
});

// A deep insert is all or nothing: a related entity that fails leaves no row of the request behind
describe("a deep insert that fails", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("two items with the same key -> 409, and neither the order nor the first item is kept", async () => {
    const r = await send(
      "POST",
      `${s.v4}/PurchaseOrderSet`,
      order("DI001", [item("0001"), item("0001")]),
    );
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /with this key already exists/);
    assert.equal((await get(`${s.v4}/PurchaseOrderSet('DI001')`)).status, 404);
    assert.equal(
      (
        await get(
          `${s.v4}/PurchaseOrderItemSet?$filter=PurchaseOrderId eq 'DI001'`,
        )
      ).body.value.length,
      0,
    );
  });

  it("an item with an invalid value -> 400 on V2, and nothing is kept", async () => {
    const bad = { ...item("0002"), Quantity: "lots" };
    const r = await send(
      "POST",
      `${s.v2}/PurchaseOrderSet`,
      order("DI002", { results: [item("0001"), bad] }),
    );
    assert.equal(r.status, 400);
    assert.equal((await get(`${s.v2}/PurchaseOrderSet('DI002')`)).status, 404);
    assert.equal(
      (
        await get(
          `${s.v2}/PurchaseOrderItemSet/$count?$filter=PurchaseOrderId eq 'DI002'`,
        )
      ).body,
      "0",
    );
  });

  it("the same request without the bad item still inserts the order and its items", async () => {
    const r = await send(
      "POST",
      `${s.v4}/PurchaseOrderSet`,
      order("DI001", [item("0001"), item("0002")]),
    );
    assert.equal(r.status, 201);
    assert.equal(
      (
        await get(
          `${s.v4}/PurchaseOrderItemSet/$count?$filter=PurchaseOrderId eq 'DI001'`,
        )
      ).body,
      "2",
    );
  });
});

// OData 4.01: the response to a deep insert is expanded as deep as the request was, so a
// client (UI5's V4 model) gets the related entities' keys and values as the server set them
describe("a deep insert's response", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("V4: has the related entities it created", async () => {
    const r = await send(
      "POST",
      `${s.v4}/PurchaseOrderSet`,
      order("DI101", [item("0001"), item("0002")]),
    );
    assert.equal(r.status, 201);
    assert.deepEqual(
      r.body.Items.map((i: { ItemPosition: string }) => i.ItemPosition),
      ["0001", "0002"],
    );
    assert.equal(r.body.Items[0].PurchaseOrderId, "DI101");
  });

  it("V2: the same, as { results }", async () => {
    const r = await send(
      "POST",
      `${s.v2}/PurchaseOrderSet`,
      order("DI102", { results: [item("0001")] }),
    );
    assert.equal(r.status, 201);
    assert.equal(r.body.d.Items.results.length, 1);
    assert.equal(r.body.d.Items.results[0].PurchaseOrderId, "DI102");
  });

  it("without related entities in the request: none expanded", async () => {
    const { Items: _items, ...flat } = order("DI103", []);
    const r = await send("POST", `${s.v4}/PurchaseOrderSet`, flat);
    assert.equal(r.status, 201);
    assert.equal("Items" in r.body, false);
  });
});

// To-one, with the foreign key on the entity sent: the related entity has to exist first, and
// the key comes from it, unlike a collection's, whose foreign key is on the entities in it.
describe("a deep insert through a to-one navigation", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const Q = "22222222-2222-4222-8222-222222222222";
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "GuidJoins"));
  });
  after(() => s.close());

  const uuid = (n: number) => `${P.slice(0, -4)}${String(n).padStart(4, "0")}`;
  const kid = (ID: number, extra: object) =>
    send("POST", `${s.v4}/Kids`, { ID, ...extra });
  const exists = async (url: string) => (await get(`${s.v4}/${url}`)).status;

  it("creates the related entity, and takes the foreign key from it", async () => {
    const r = await kid(100, { Parent: { ID: P, Name: "new" } });
    assert.equal(r.status, 201);
    assert.equal(r.body.ParentID, P);
    assert.equal(r.body.Parent.Name, "new");
    assert.equal((await get(`${s.v4}/Kids(100)/Parent`)).body.ID, P);
    assert.equal((await get(`${s.v4}/Parents(${P})`)).body.Name, "new");
  });

  it("the related entity's other navigations are created too", async () => {
    const id = uuid(1);
    const r = await kid(101, { Parent: { ID: id, Kids: [{ ID: 102 }] } });
    assert.equal(r.status, 201);
    assert.equal((await get(`${s.v4}/Kids(102)`)).body.ParentID, id);
  });

  it("a foreign key equal to the related entity's key is fine, in upper or lower case", async () => {
    const id = uuid(2);
    const r = await kid(103, {
      ParentID: id,
      Parent: { ID: id.toUpperCase() },
    });
    assert.equal(r.status, 201);
  });

  it("a foreign key alone gives the related entity its key", async () => {
    const id = uuid(3);
    const r = await kid(104, { ParentID: id, Parent: { Name: "named" } });
    assert.equal(r.status, 201);
    assert.equal((await get(`${s.v4}/Parents(${id})`)).body.Name, "named");
  });

  it("a foreign key that differs from the related entity's key is a 400, and nothing is created", async () => {
    const r = await kid(105, { ParentID: Q, Parent: { ID: uuid(4) } });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /ParentID/);
    assert.equal(await exists("Kids(105)"), 404);
    assert.equal(await exists(`Parents(${uuid(4)})`), 404);
    assert.equal(await exists(`Parents(${Q})`), 404);
  });

  it("an invalid related entity -> 400, and nothing is created", async () => {
    const r = await kid(106, { Parent: { ID: uuid(5), Nope: 1 } });
    assert.equal(r.status, 400);
    assert.equal(await exists("Kids(106)"), 404);
  });

  it("when the entity itself fails, the related entity it created is undone", async () => {
    await kid(107, {});
    const r = await kid(107, { Parent: { ID: uuid(6) } });
    assert.equal(r.status, 409);
    assert.equal(await exists(`Parents(${uuid(6)})`), 404);
  });

  it("a related entity that exists already is a 409", async () => {
    await send("POST", `${s.v4}/Parents`, { ID: uuid(7) });
    const r = await kid(108, { Parent: { ID: uuid(7) } });
    assert.equal(r.status, 409);
    assert.equal(await exists("Kids(108)"), 404);
  });

  it("V2 too", async () => {
    const id = uuid(8);
    const r = await send("POST", `${s.v2}/Kids`, {
      ID: 109,
      Parent: { ID: id, Name: "v2" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.d.ParentID, id);
    assert.equal((await get(`${s.v4}/Parents(${id})`)).body.Name, "v2");
  });

  it("in a changeset, undone with it", async () => {
    const res = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "Kids",
          body: { ID: 110, Parent: { ID: uuid(9) } },
        },
        { method: "POST", url: "Kids", body: { ID: 110 } },
      ],
    ]);
    assert.equal(batchResponses(res.text)[0].status, 409);
    assert.equal(await exists(`Parents(${uuid(9)})`), 404);
    assert.equal(await exists("Kids(110)"), 404);
  });
});
