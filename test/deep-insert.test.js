import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, send } from "./helpers.js";

const item = (pos) => ({
  ItemPosition: pos,
  Material: "X",
  Description: "x",
  Quantity: "1.000",
  Unit: "EA",
  NetPrice: "1.00",
  Currency: "EUR",
});
const order = (id, items) => ({
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
  let s;
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
