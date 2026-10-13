import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, type TestServer } from "./helpers.ts";

// Decimals as strings, as UI5's V4 model asks for them
const IEEE754 = { Accept: "application/json;IEEE754Compatible=true" };

describe("$apply", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const apply = (query: string, path = "PurchaseOrderSet") =>
    get(`${s.v4}/${path}?${query}`, IEEE754);

  it("groupby with aggregate -> a row per group, with a context listing its properties", async () => {
    const r = await apply(
      "$apply=groupby((Currency),aggregate(TotalAmount with sum as Total,$count as Count))",
    );
    assert.equal(r.status, 200);
    assert.equal(
      r.body["@odata.context"],
      "/odata/v4/T/$metadata#PurchaseOrderSet(Currency,Total,Count)",
    );
    assert.deepEqual(r.body.value, [
      { Currency: "EUR", Total: "59800.50", Count: "3" },
      { Currency: "USD", Total: "9460.74", Count: "2" },
    ]);
  });

  it("aggregate -> one row, with sum, average, min, max and countdistinct", async () => {
    const r = await apply(
      "$apply=filter(Status ne 'Cancelled')/aggregate(TotalAmount with sum as Total," +
        "TotalAmount with average as Average,TotalAmount with min as Min," +
        "TotalAmount with max as Max,Supplier with countdistinct as Suppliers)",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      {
        Total: "68700.49",
        Average: "17175.1225",
        Min: "2100.00",
        Max: "45200.50",
        Suppliers: "4",
      },
    ]);
  });

  it("sums decimals exactly, and as numbers without IEEE754Compatible", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderSet('4500000001')/Items?$apply=aggregate(NetPrice with sum as Total)`,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [{ Total: 37.5 }]);
  });

  it("over no rows: aggregate gives a row of nulls and a zero count, groupby no rows", async () => {
    const none = "filter(Status eq 'none')";
    const r = await apply(
      `$apply=${none}/aggregate(TotalAmount with sum as Total,$count as Count)`,
    );
    assert.deepEqual(r.body.value, [{ Total: null, Count: "0" }]);
    const g = await apply(`$apply=${none}/groupby((Currency))`);
    assert.deepEqual(g.body.value, []);
  });

  it("the other query options work on the result, aliases included", async () => {
    const r = await apply(
      "$apply=groupby((CompanyCode,Currency))&$orderby=CompanyCode desc&$count=true&$top=2",
    );
    assert.equal(r.body["@odata.count"], 3);
    assert.deepEqual(r.body.value, [
      { CompanyCode: "3000", Currency: "USD" },
      { CompanyCode: "2000", Currency: "USD" },
    ]);
    for (const query of [
      "$apply=groupby((Currency),aggregate(TotalAmount with sum as Total))&$filter=Total gt 10000",
      "$apply=groupby((Currency),aggregate(TotalAmount with sum as Total))/filter(Total gt 10000)",
    ]) {
      const f = await apply(query);
      assert.deepEqual(f.body.value, [{ Currency: "EUR", Total: "59800.50" }]);
    }
    const c = await get(
      `${s.v4}/PurchaseOrderSet/$count?$apply=groupby((Currency))`,
    );
    assert.equal(c.body, "2");
  });

  it("a mistake -> 400", async () => {
    for (const [query, message] of [
      ["$apply=groupby((Nope))", /^Unknown property Nope on PurchaseOrder$/],
      [
        "$apply=aggregate(Supplier with sum as S)",
        /sum needs a number, and Supplier is Edm.String/,
      ],
      [
        "$apply=aggregate(TotalAmount with sum as Currency)",
        /alias Currency is already in use/,
      ],
      [
        "$apply=aggregate(TotalAmount with median as M)",
        /unknown aggregation method median/,
      ],
      ["$apply=groupby(Currency)", /^Invalid \$apply/],
      [
        "$apply=groupby((Currency))/filter(Status eq 'Open')",
        /^Unknown property Status/,
      ],
    ] as const) {
      const r = await apply(query);
      assert.equal(r.status, 400, query);
      assert.match(r.body.error.message, message, query);
    }
    const one = await apply(
      "$apply=groupby((Currency))",
      "PurchaseOrderSet('4500000001')",
    );
    assert.equal(one.status, 400);
  });

  it("what isn't supported -> 501, never ignored", async () => {
    for (const query of [
      "$apply=aggregate(TotalAmount)",
      "$apply=topcount(2,TotalAmount)",
      "$apply=groupby((Currency),filter(Status eq 'Open'))",
      "$apply=aggregate(TotalAmount with Custom.median as M)",
      "$apply=groupby((Items/Material))",
      "$apply=groupby((Currency))&$select=Currency",
      "$apply=groupby((Currency))&$expand=Items",
    ]) {
      const r = await apply(query);
      assert.equal(r.status, 501, query);
    }
  });
});
