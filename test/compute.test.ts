import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, type TestServer } from "./helpers.ts";

// $compute on the PurchaseOrderSrv fixture's orders and items
const IEEE754 = { accept: "application/json;IEEE754Compatible=true" };

describe("$compute", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("adds a property to each entity, typed by its expression", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderSet?$filter=PurchaseOrderId eq '4500000001'` +
        `&$compute=TotalAmount mul 2 as Doubled,year(OrderDate) as Year,concat(concat(Status,': '),Supplier) as Label`,
    );
    assert.equal(r.status, 200);
    const [order] = r.body.value;
    assert.equal(order.Doubled, 25000); // a Decimal, a number without IEEE754Compatible
    assert.equal(order.Year, 2025);
    assert.equal(order.Label, "Open: Acme Components Ltd");
    assert.equal(order.TotalAmount, 12500); // the entity's own properties too
  });

  it("$filter, $orderby and $select use the computed property", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderItemSet?$compute=Quantity mul NetPrice as LineTotal` +
        `&$filter=LineTotal gt 5000&$orderby=LineTotal desc&$select=Material,LineTotal`,
      IEEE754,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      { Material: "MAT-2001", LineTotal: "42000" },
      { Material: "MAT-3001", LineTotal: "8500" },
      { Material: "MAT-1001", LineTotal: "7500" },
    ]);
  });

  it("a path through a single-valued navigation", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderItemSet?$compute=PurchaseOrder/Status as OrderStatus&$filter=OrderStatus eq 'Cancelled'&$select=Material`,
    );
    assert.deepEqual(r.body.value, [{ Material: "MAT-5001" }]);
  });

  it("a single entity, $count and an $expand", async () => {
    const one = await get(
      `${s.v4}/PurchaseOrderSet('4500000002')?$compute=length(Supplier) as NameLength&$select=NameLength`,
    );
    assert.equal(one.status, 200);
    assert.equal(one.body.NameLength, 15);

    const count = await get(
      `${s.v4}/PurchaseOrderItemSet/$count?$compute=Quantity mul NetPrice as LineTotal&$filter=LineTotal lt 1000`,
    );
    assert.equal(count.body, "2");

    const expanded = await get(
      `${s.v4}/PurchaseOrderSet('4500000001')?$select=PurchaseOrderId` +
        `&$expand=Items($compute=Quantity mul NetPrice as LineTotal;$select=LineTotal;$orderby=LineTotal)`,
    );
    assert.equal(expanded.status, 200);
    assert.deepEqual(
      expanded.body.Items.map((i: { LineTotal: number }) => i.LineTotal),
      [4500, 7500],
    );
  });

  it("an integer division rounds towards zero, divby doesn't", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderSet('4500000001')?$compute=length(Supplier) div 2 as Half,length(Supplier) divby 2 as Exact&$select=Half,Exact`,
    );
    // "Acme Components Ltd" has 19 characters
    assert.equal(r.body.Half, 9);
    assert.equal(r.body.Exact, 9.5);
  });

  it("a mistake in it is a 400", async () => {
    const bad = {
      "no alias": "TotalAmount mul 2",
      "an unknown property": "Nope mul 2 as X",
      "an alias that's a property": "TotalAmount mul 2 as Status",
      "an alias twice": "1 add 1 as X,2 add 2 as X",
      "arithmetic on text": "Status add 1 as X",
      "an unknown function": "frobnicate(Status) as X",
      "a collection navigation": "Items/Material as X",
      "a null alone": "null as X",
      "a division by zero": "TotalAmount div 0 as X",
    };
    for (const [what, compute] of Object.entries(bad)) {
      const r = await get(`${s.v4}/PurchaseOrderSet?$compute=${compute}`);
      assert.equal(r.status, 400, what);
    }
  });

  it("V2, which has none, and with $apply -> 501", async () => {
    const v2 = await get(
      `${s.v2}/PurchaseOrderSet?$compute=TotalAmount mul 2 as Doubled`,
    );
    assert.equal(v2.status, 501);
    assert.match(
      v2.body.error.message.value,
      /\$compute is not supported in OData V2/,
    );
    const apply = await get(
      `${s.v4}/PurchaseOrderSet?$apply=filter(Status eq 'Open')&$compute=TotalAmount mul 2 as Doubled`,
    );
    assert.equal(apply.status, 501);
  });
});
