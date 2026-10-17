import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send, type TestServer } from "./helpers.ts";

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

  // UI5's leaf rows: the entities themselves (identity), with a count in a row of its own
  it("expands the entities in the result, with their own options", async () => {
    const r = await apply(
      "$apply=filter(Status eq 'Open')/concat(aggregate($count as UI5__count),identity)" +
        "&$expand=Items($select=Material)&$select=PurchaseOrderId,TotalAmount,UI5__count",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      { UI5__count: "2" },
      {
        PurchaseOrderId: "4500000001",
        TotalAmount: "12500.00",
        Items: [{ Material: "MAT-1001" }, { Material: "MAT-1002" }],
      },
      {
        PurchaseOrderId: "4500000004",
        TotalAmount: "2100.00",
        Items: [{ Material: "MAT-4001" }],
      },
    ]);

    // A groupby's filter passes the entities on too
    const filtered = await apply(
      "$apply=groupby((Currency),filter($these/aggregate(TotalAmount with sum) gt 50000))" +
        "&$expand=Items($top=1;$select=ItemPosition)&$select=PurchaseOrderId&$top=1",
    );
    assert.deepEqual(filtered.body.value, [
      { PurchaseOrderId: "4500000001", Items: [{ ItemPosition: "0001" }] },
    ]);

    for (const [query, message] of [
      [
        "$apply=groupby((Currency))&$expand=Items",
        /\$expand needs entities in the \$apply result/,
      ],
      [
        "$apply=concat(aggregate($count as C),groupby((Currency)))&$expand=Items",
        /\$expand needs entities/,
      ],
      ["$apply=identity&$expand=Nope", /Nope is not a navigation property/],
    ] as const) {
      const bad = await apply(query);
      assert.equal(bad.status, 400, query);
      assert.match(bad.body.error.message, message, query);
    }
  });

  // Order amounts: 12500.00, 45200.50, 8899.99, 2100.00 and 560.75, 69261.24 in all
  it("topcount, bottomcount, topsum, bottomsum, toppercent and bottompercent", async () => {
    const ids = async (transformation: string) => {
      const r = await apply(`$apply=${transformation}&$select=PurchaseOrderId`);
      assert.equal(r.status, 200, transformation);
      return r.body.value.map((o: { PurchaseOrderId: string }) =>
        o.PurchaseOrderId.slice(-1),
      );
    };
    assert.deepEqual(await ids("topcount(2,TotalAmount)"), ["2", "1"]);
    assert.deepEqual(await ids("bottomcount(1,TotalAmount)"), ["5"]);
    // 45200.50 is less than 50000, and 45200.50 + 12500.00 isn't
    assert.deepEqual(await ids("topsum(50000,TotalAmount)"), ["2", "1"]);
    assert.deepEqual(await ids("bottomsum(3000,TotalAmount)"), ["5", "4", "3"]);
    assert.deepEqual(await ids("topsum(0,TotalAmount)"), []);
    // 60% of the total is 41556.74; 10% is 6926.12
    assert.deepEqual(await ids("toppercent(60,TotalAmount)"), ["2"]);
    assert.deepEqual(await ids("bottompercent(10,TotalAmount)"), [
      "5",
      "4",
      "3",
    ]);
    assert.deepEqual(
      await ids("filter(Currency eq 'USD')/topcount(5,TotalAmount)"),
      ["3", "5"],
    );

    // By an alias, after a groupby, and by a path
    const byAlias = await apply(
      "$apply=groupby((Currency),aggregate(TotalAmount with sum as Total))/topcount(1,Total)",
    );
    assert.deepEqual(byAlias.body.value, [
      { Currency: "EUR", Total: "59800.50" },
    ]);
    const byPath = await apply(
      "$apply=bottomcount(1,PurchaseOrder/TotalAmount)&$select=PurchaseOrderId,ItemPosition",
      "PurchaseOrderItemSet",
    );
    assert.deepEqual(byPath.body.value, [
      { PurchaseOrderId: "4500000005", ItemPosition: "0001" },
    ]);

    for (const [query, message] of [
      [
        "$apply=topsum(1,Supplier)",
        /topsum needs a number, and Supplier is Edm.String/,
      ],
      ["$apply=topcount(1,Nope)", /Unknown property Nope/],
      ["$apply=topcount(-1,TotalAmount)", /Invalid \$apply/],
      ["$apply=topcount(1.5,TotalAmount)", /Invalid \$apply/],
      ["$apply=toppercent(101,TotalAmount)", /a percentage is 0 to 100/],
      ["$apply=topsum(10)", /Invalid \$apply/],
    ] as const) {
      const r = await apply(query);
      assert.equal(r.status, 400, query);
      assert.match(r.body.error.message, message, query);
    }
  });

  // A path through single-valued navigations: the order of each item. The response nests it
  it("groups and aggregates by a path, nested in the response", async () => {
    const r = await apply(
      "$apply=groupby((PurchaseOrder/Status),aggregate(NetPrice with sum as Total,$count as Count))" +
        "&$orderby=PurchaseOrder/Status desc&$top=2",
      "PurchaseOrderItemSet",
    );
    assert.equal(r.status, 200);
    assert.equal(
      r.body["@odata.context"],
      "/odata/v4/T/$metadata#PurchaseOrderItemSet(PurchaseOrder(Status),Total,Count)",
    );
    assert.deepEqual(r.body.value, [
      { PurchaseOrder: { Status: "Open" }, Total: "38.20", Count: "3" },
      { PurchaseOrder: { Status: "Completed" }, Total: "408.49", Count: "2" },
    ]);

    const filtered = await apply(
      "$apply=groupby((PurchaseOrder/Currency,Unit))" +
        "&$filter=PurchaseOrder/Currency eq 'EUR'&$select=PurchaseOrder,Unit",
      "PurchaseOrderItemSet",
    );
    assert.deepEqual(filtered.body.value, [
      { PurchaseOrder: { Currency: "EUR" }, Unit: "EA" },
      { PurchaseOrder: { Currency: "EUR" }, Unit: "TO" },
    ]);

    const max = await apply(
      "$apply=aggregate(PurchaseOrder/TotalAmount with max as Max)",
      "PurchaseOrderItemSet",
    );
    assert.deepEqual(max.body.value, [{ Max: "45200.50" }]);

    for (const [query, message] of [
      [
        "$apply=groupby((PurchaseOrder/Nope))",
        /Unknown property PurchaseOrder\/Nope/,
      ],
      [
        "$apply=groupby((Nope/Status))",
        /Nope in Nope\/Status is not a navigation/,
      ],
    ] as const) {
      const bad = await apply(query, "PurchaseOrderItemSet");
      assert.equal(bad.status, 400, query);
      assert.match(bad.body.error.message, message, query);
    }
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
        "$apply=aggregate(TotalAmount)",
        /TotalAmount is not a custom aggregate of PurchaseOrder/,
      ],
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

  it("compute adds a property the transformations after it use", async () => {
    const r = await apply(
      "$apply=compute(TotalAmount mul 2 as Doubled)/filter(Doubled gt 20000)/orderby(Doubled desc)&$select=PurchaseOrderId,Doubled",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      { PurchaseOrderId: "4500000002", Doubled: "90401" },
      { PurchaseOrderId: "4500000001", Doubled: "25000" },
    ]);

    const byMonth = await apply(
      "$apply=compute(month(OrderDate) as Month)/groupby((Month),aggregate($count as Count))",
    );
    assert.deepEqual(byMonth.body.value, [
      { Month: 1, Count: "1" },
      { Month: 2, Count: "2" },
      { Month: 3, Count: "2" },
    ]);

    // Its rows are copies with a property more, not entities to expand
    const expanded = await apply(
      "$apply=compute(TotalAmount mul 2 as Doubled)&$expand=Items",
    );
    assert.equal(expanded.status, 400);
    for (const query of [
      "$apply=compute(TotalAmount mul 2)",
      "$apply=compute(Nope mul 2 as X)",
      "$apply=compute(Status add 1 as X)",
    ]) {
      const bad = await apply(query);
      assert.equal(bad.status, 400, query);
      assert.match(bad.body.error.message, /\$apply/, query);
    }
  });

  it("topcount and the others by an expression; a count by any value", async () => {
    const ids = async (transformation: string) => {
      const r = await apply(`$apply=${transformation}&$select=PurchaseOrderId`);
      assert.equal(r.status, 200, transformation);
      return r.body.value.map((o: { PurchaseOrderId: string }) =>
        o.PurchaseOrderId.slice(-1),
      );
    };
    assert.deepEqual(await ids("topcount(1,TotalAmount mul -1)"), ["5"]);
    assert.deepEqual(await ids("topcount(1,-TotalAmount)"), ["5"]);
    // Nordic Steel AB has 15 characters, Acme Components Ltd 19
    assert.deepEqual(await ids("bottomcount(2,length(Supplier))"), ["2", "1"]);
    assert.deepEqual(await ids("topsum(15000,TotalAmount div 2)"), ["2"]);
    // Text alphabetically, dates by time
    assert.deepEqual(await ids("topcount(1,Supplier)"), ["5"]);
    assert.deepEqual(await ids("bottomcount(1,OrderDate)"), ["1"]);

    for (const [query, message] of [
      ["$apply=topsum(1,concat(Supplier,'x'))", /topsum needs a number/],
      ["$apply=topcount(1,Nope mul 2)", /Unknown property Nope/],
    ] as const) {
      const r = await apply(query);
      assert.equal(r.status, 400, query);
      assert.match(r.body.error.message, message, query);
    }
  });

  it("groupby runs any sequence on each group", async () => {
    // The highest order of each currency: still entities, which $expand expands
    const top = await apply(
      "$apply=groupby((Currency),topcount(1,TotalAmount))&$select=PurchaseOrderId&$expand=Items($select=Material)",
    );
    assert.equal(top.status, 200);
    assert.deepEqual(
      top.body.value.map((o: { PurchaseOrderId: string; Items: unknown[] }) => [
        o.PurchaseOrderId,
        o.Items.length,
      ]),
      [
        ["4500000002", 2],
        ["4500000003", 2],
      ],
    );

    // Rows a sequence makes get the group's values
    const totals = await apply(
      "$apply=groupby((Currency),aggregate(TotalAmount with sum as Total)/filter(Total gt 10000))",
    );
    assert.deepEqual(totals.body.value, [
      { Currency: "EUR", Total: "59800.50" },
    ]);

    // $these is the group in each filter of the sequence
    const big = await apply(
      "$apply=groupby((Currency),filter($these/aggregate($count) gt 2)/top(1))&$select=PurchaseOrderId",
    );
    assert.deepEqual(big.body.value, [{ PurchaseOrderId: "4500000001" }]);
  });

  it("a path through a collection navigation: a row for each related entity", async () => {
    const r = await apply(
      "$apply=groupby((Items/Currency),aggregate(Items/NetPrice with sum as Total,$count as Count))",
    );
    assert.equal(r.status, 200);
    assert.equal(
      r.body["@odata.context"],
      "/odata/v4/T/$metadata#PurchaseOrderSet(Items(Currency),Total,Count)",
    );
    assert.deepEqual(r.body.value, [
      { Items: [{ Currency: "EUR" }], Total: "7438.70", Count: "5" },
      { Items: [{ Currency: "USD" }], Total: "969.24", Count: "3" },
    ]);

    // Aggregated without grouping by it: the values of all the related entities
    const all = await apply(
      "$apply=filter(Status eq 'Open')/aggregate(Items/NetPrice with max as Max,Items/NetPrice with sum as Total,$count as Orders)",
    );
    assert.deepEqual(all.body.value, [
      { Max: "22.50", Total: "38.20", Orders: "2" },
    ]);

    const ranked = await apply("$apply=topcount(1,Items/NetPrice)");
    assert.equal(ranked.status, 400);
  });

  it("what isn't supported -> 501, never ignored", async () => {
    for (const query of [
      "$apply=aggregate(TotalAmount with Custom.median as M)",
      "$apply=groupby((Items/PurchaseOrder/Items/Material))",
    ]) {
      const r = await apply(query);
      assert.equal(r.status, 501, query);
    }
  });
});

// Aggregation.CustomAggregate inline on the type (Amount, Currency), and on the set in an
// <Annotations> block (Quantity); UI5 asks for these with no "with"
describe("$apply with custom aggregates", () => {
  let s: TestServer;
  before(async () => {
    s = await start(
      path.join(import.meta.dirname, "fixtures", "AggregationSrv"),
    );
  });
  after(() => s.close());

  const apply = (query: string) => get(`${s.v4}/Sales?${query}`, IEEE754);

  it("sums a number, and gives the unit the rows share, or null when they differ", async () => {
    const r = await apply(
      "$apply=groupby((Country),aggregate(Amount,Currency,Quantity))",
    );
    assert.equal(r.status, 200);
    assert.equal(
      r.body["@odata.context"],
      "/odata/v4/T/$metadata#Sales(Country,Amount,Currency,Quantity)",
    );
    assert.deepEqual(r.body.value, [
      { Country: "Germany", Amount: "300.30", Currency: "EUR", Quantity: 7 },
      { Country: "France", Amount: "50.00", Currency: "EUR", Quantity: 1 },
      { Country: "USA", Amount: "80.00", Currency: "USD", Quantity: 2 },
    ]);
    const total = await apply("$apply=aggregate(Amount,Currency)");
    assert.deepEqual(total.body.value, [{ Amount: "430.30", Currency: null }]);
  });

  it("averages decimals exactly, rounding one that doesn't end", async () => {
    const r = await apply(
      "$apply=groupby((Country),aggregate(Amount with average as Avg,Quantity with average as Qty))",
    );
    assert.deepEqual(r.body.value, [
      { Country: "Germany", Avg: "150.15", Qty: "3.5" },
      { Country: "France", Avg: "50", Qty: "1" },
      { Country: "USA", Avg: "80", Qty: "2" },
    ]);
    const thirds = await apply(
      "$apply=filter(Country ne 'USA')/aggregate(Amount with average as Avg)",
    );
    assert.deepEqual(thirds.body.value, [{ Avg: "116.766666666666666667" }]);
  });

  it("takes an alias, and mixes with the standard methods", async () => {
    const r = await apply(
      "$apply=filter(Currency eq 'EUR')/aggregate(Amount as Total,Amount with max as Max)&$filter=Total gt 0",
    );
    assert.deepEqual(r.body.value, [{ Total: "350.30", Max: "200.20" }]);
  });

  it("a property that isn't one -> 400", async () => {
    const r = await apply("$apply=aggregate(Country)");
    assert.equal(r.status, 400);
    assert.match(
      r.body.error.message,
      /Country is not a custom aggregate of Sales/,
    );
  });
});

// What UI5's V4 model sends for an aggregated table (see sap/ui/model/odata/v4/lib/
// _AggregationHelper.js): the rows it shows, and a concat with rows of their own for the
// count, min and max, the grand total and the leaves
describe("$apply as UI5 sends it", () => {
  let s: TestServer;
  before(async () => {
    s = await start(
      path.join(import.meta.dirname, "fixtures", "AggregationSrv"),
    );
  });
  after(() => s.close());

  const apply = (query: string) => get(`${s.v4}/Sales?${query}`, IEEE754);

  it("count, min and max in a row of their own, then a page of groups", async () => {
    const r = await apply(
      "$apply=groupby((Country),aggregate(Amount,Currency))/orderby(Country)" +
        "/concat(aggregate(Amount with min as UI5min__Amount,Amount with max as UI5max__Amount," +
        "$count as UI5__count),skip(1)/top(1))",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      { UI5min__Amount: "50.00", UI5max__Amount: "300.30", UI5__count: "3" },
      { Country: "Germany", Amount: "300.30", Currency: "EUR" },
    ]);
  });

  it("leaves and the grand total before the groups", async () => {
    const r = await apply(
      "$apply=concat(groupby((Country))/aggregate($count as UI5__leaves)," +
        "aggregate(Amount as UI5grand__Amount,Currency)," +
        "groupby((Country),aggregate(Amount,Currency))/orderby(Amount desc)/top(2))",
    );
    assert.deepEqual(r.body.value, [
      { UI5__leaves: "3" },
      { UI5grand__Amount: "430.30", Currency: null },
      { Country: "Germany", Amount: "300.30", Currency: "EUR" },
      { Country: "USA", Amount: "80.00", Currency: "USD" },
    ]);
  });

  it("search and identity: the entities themselves, with $select", async () => {
    const r = await apply(
      "$apply=search(Germany)/concat(aggregate($count as UI5__count),identity)" +
        "&$select=ID,Amount,UI5__count",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      { UI5__count: "2" },
      { ID: 1, Amount: "100.10" },
      { ID: 2, Amount: "200.20" },
    ]);
    const unknown = await apply("$apply=identity&$select=Nope");
    assert.equal(unknown.status, 400);
    assert.match(
      unknown.body.error.message,
      /Nope is not a property of the \$apply result/,
    );
  });

  // As a Fiori Elements V4 analytical table sent them: with no grouping, grouped (with the
  // leaves, the grand total and subtotals), and one group expanded
  it("a Fiori Elements analytical table's requests", async () => {
    const flat = await apply(
      "$apply=concat(aggregate(Amount,Currency)," +
        "groupby((Country,Currency,ID),aggregate(Amount))" +
        "/concat(aggregate($count as UI5__count),top(139)))",
    );
    assert.equal(flat.status, 200);
    assert.deepEqual(flat.body.value.slice(0, 3), [
      { Amount: "430.30", Currency: null },
      { UI5__count: "5" },
      { Country: "Germany", Currency: "EUR", ID: 1, Amount: "100.10" },
    ]);
    assert.equal(flat.body.value.length, 7);

    const grouped = await apply(
      "$apply=concat(groupby((Country,Currency,ID))/aggregate($count as UI5__leaves)," +
        "aggregate(Amount,Currency)," +
        "groupby((Country),aggregate(Amount,Currency))" +
        "/concat(aggregate($count as UI5__count),top(139)))",
    );
    assert.deepEqual(grouped.body.value, [
      { UI5__leaves: "5" },
      { Amount: "430.30", Currency: null },
      { UI5__count: "3" },
      { Country: "Germany", Amount: "300.30", Currency: "EUR" },
      { Country: "France", Amount: "50.00", Currency: "EUR" },
      { Country: "USA", Amount: "80.00", Currency: "USD" },
    ]);

    const group = await apply(
      "$apply=filter(Country eq 'USA')/groupby((Currency,ID),aggregate(Amount))" +
        "&$count=true&$skip=0&$top=139",
    );
    assert.equal(group.body["@odata.count"], 2);
    assert.deepEqual(group.body.value, [
      { Currency: "USD", ID: 4, Amount: "80.00" },
      { Currency: "USD", ID: 5, Amount: null },
    ]);
  });

  // $$filterOnAggregate: the countries whose Amount adds up to more than 100, then grouped
  it("filtering groups on their aggregated values, with $these/aggregate", async () => {
    const r = await apply(
      "$apply=groupby((Country),filter($these/aggregate(Amount) gt 100))" +
        "/groupby((Country),aggregate(Amount,Currency))",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      { Country: "Germany", Amount: "300.30", Currency: "EUR" },
    ]);

    // With a unit's filter on the rows, as UI5 adds one, and a standard method and $count.
    // USA has two rows, one with no Amount.
    const mixed = await apply(
      "$apply=groupby((Country,Currency),filter(Currency eq 'USD' or " +
        "$these/aggregate(Amount with sum) ge 300 and $these/aggregate($count) eq 2))" +
        "/groupby((Country),aggregate(Amount))",
    );
    assert.deepEqual(mixed.body.value, [
      { Country: "Germany", Amount: "300.30" },
      { Country: "USA", Amount: "80.00" },
    ]);

    // With no $these, the filter is on each group's rows
    const rows = await apply(
      "$apply=groupby((Country),filter(Amount gt 100))&$select=ID",
    );
    assert.deepEqual(rows.body.value, [{ ID: 1 }, { ID: 2 }]);
  });

  it("$these/aggregate outside a groupby's filter, or a wrong one -> 400", async () => {
    for (const [query, message] of [
      [
        "$filter=$these/aggregate(Amount) gt 1",
        /only allowed in a groupby's filter/,
      ],
      [
        "$apply=groupby((Country),filter($these/aggregate(Nope) gt 1))",
        /Nope is not a custom aggregate/,
      ],
      [
        "$apply=groupby((Country),filter($these/aggregate(Country with sum) gt 1))",
        /sum needs a number/,
      ],
      [
        "$apply=groupby((Country),filter($these/aggregate(Amount,Quantity) gt 1))",
        /takes one aggregate/,
      ],
      [
        "$apply=groupby((Country),filter($these/aggregate(Amount gt 1))",
        /Unterminated \$these\/aggregate/,
      ],
    ] as const) {
      const r = await apply(query);
      assert.equal(r.status, 400, query);
      assert.match(r.body.error.message, message, query);
    }
  });

  it("a mistake -> 400", async () => {
    for (const query of [
      "$apply=top(-1)",
      "$apply=skip(x)",
      "$apply=concat(identity)",
      "$apply=identity()",
    ]) {
      const r = await apply(query);
      assert.equal(r.status, 400, query);
    }
  });
});

// An operation's result, when it's a collection of entities
describe("$apply on an operation", () => {
  let s: TestServer;
  const logs: string[] = [];
  before(async () => {
    s = await start(
      path.join(import.meta.dirname, "fixtures", "OperationsV2"),
      {
        log: (line) => logs.push(line),
      },
    );
  });
  after(() => s.close());

  it("transforms a function's collection of entities", async () => {
    const r = await get(
      `${s.v4}/GetOpenOrders()?$apply=groupby((Status),aggregate(Amount with sum as Total))`,
      IEEE754,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [
      { Status: "Open", Total: "1200.00" },
      { Status: "Approved", Total: "450.50" },
    ]);
    const filtered = await get(
      `${s.v4}/GetOpenOrders()?$apply=filter(Amount gt 1000)&$count=true&$select=PurchaseOrderId`,
    );
    assert.equal(filtered.body["@odata.count"], 1);
    assert.deepEqual(filtered.body.value, [{ PurchaseOrderId: "4500000001" }]);
  });

  it("on any other result -> 400, before an action runs", async () => {
    for (const u of [
      "GetOrderDates()?$apply=identity",
      "GetStatusText()?$apply=identity",
    ]) {
      const r = await get(`${s.v4}/${u}`);
      assert.equal(r.status, 400, u);
      assert.match(r.body.error.message, /applies to a collection of entities/);
    }
    logs.length = 0;
    const action = await send(
      "POST",
      `${s.v4}/PurchaseOrderSet('4500000001')/ZPO_SRV.ApprovePurchaseOrder?$apply=identity`,
      {},
    );
    assert.equal(action.status, 400);
    assert.deepEqual(
      logs.filter((l) => l.includes("ApprovePurchaseOrder")),
      [],
    );
  });
});
