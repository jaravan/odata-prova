import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, type TestServer } from "./helpers.ts";

describe("$select is checked against the type", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("an unknown property -> 400 on both protocols, also when no entity matches", async () => {
    for (const url of [
      `${s.v4}/PurchaseOrderSet?$select=Nope`,
      `${s.v4}/PurchaseOrderSet?$select=Supplier,Nope&$filter=Status eq 'none'`,
      `${s.v4}/PurchaseOrderSet('4500000001')?$select=Nope`,
      `${s.v4}/PurchaseOrderSet('4500000001')?$expand=Items($select=Nope)`,
    ]) {
      const r = await get(url);
      assert.equal(r.status, 400, url);
      assert.match(
        r.body.error.message,
        /^Nope is not a property or navigation of (PurchaseOrder|PurchaseOrderItem)$/,
      );
    }
    for (const url of [
      `${s.v2}/PurchaseOrderSet?$select=Nope`,
      `${s.v2}/PurchaseOrderSet('4500000001')?$expand=Items&$select=Items/Nope`,
    ]) {
      const r = await get(url);
      assert.equal(r.status, 400, url);
      assert.match(
        r.body.error.message.value,
        /^Nope is not a property or navigation of /,
      );
    }
  });

  it("accepts properties, navigations and *", async () => {
    for (const url of [
      `${s.v4}/PurchaseOrderSet?$select=Supplier,Items`,
      `${s.v4}/PurchaseOrderSet?$select=*`,
      `${s.v2}/PurchaseOrderSet?$select=Supplier,Items`,
    ])
      assert.equal((await get(url)).status, 200, url);
  });
});

describe("$select through a navigation", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const ITEMS = "PurchaseOrderItemSet?$top=1";
  const fields = (row: object) =>
    Object.keys(row).filter((k) => !k.startsWith("@") && k !== "__metadata");

  for (const query of [
    `${ITEMS}&$select=PurchaseOrder/Status`,
    `${ITEMS}&$select=Material,PurchaseOrder/Status`,
    `${ITEMS}&$expand=PurchaseOrder&$select=PurchaseOrder/Status`,
    "PurchaseOrderSet?$select=Items/Material",
    "PurchaseOrderSet?$expand=Items($select=PurchaseOrder/Status)",
  ]) {
    it(`V4: ${query} is a 400 saying how to write it`, async () => {
      const r = await get(`${s.v4}/${query}`);
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, /\$expand=.*\$select=/);
    });
  }

  it("V4: $expand with a $select narrows it", async () => {
    const r = await get(
      `${s.v4}/${ITEMS}&$select=Material&$expand=PurchaseOrder($select=Status)`,
    );
    const [row] = r.body.value;
    assert.deepEqual(fields(row), ["Material", "PurchaseOrder"]);
    assert.deepEqual(fields(row.PurchaseOrder), ["Status"]);
  });

  it("V4: a navigation may end a $select", async () => {
    const r = await get(`${s.v4}/${ITEMS}&$select=Material,PurchaseOrder`);
    assert.equal(r.status, 200);
    assert.deepEqual(fields(r.body.value[0]), ["Material"]);
  });

  it("V2: only what was selected, at each level", async () => {
    const r = await get(
      `${s.v2}/${ITEMS}&$expand=PurchaseOrder&$select=PurchaseOrder/Status`,
    );
    const [row] = r.body.d.results;
    assert.deepEqual(fields(row), ["PurchaseOrder"]);
    assert.deepEqual(fields(row.PurchaseOrder), ["Status"]);
  });

  it("V2: with a property of its own", async () => {
    const r = await get(
      `${s.v2}/${ITEMS}&$expand=PurchaseOrder&$select=Material,PurchaseOrder/Status`,
    );
    const [row] = r.body.d.results;
    assert.deepEqual(fields(row), ["Material", "PurchaseOrder"]);
    assert.deepEqual(fields(row.PurchaseOrder), ["Status"]);
  });

  it("V2: two levels down", async () => {
    const r = await get(
      `${s.v2}/PurchaseOrderSet('4500000001')?$expand=Items/PurchaseOrder&$select=Items/PurchaseOrder/Status`,
    );
    assert.deepEqual(fields(r.body.d), ["Items"]);
    const [item] = r.body.d.Items.results;
    assert.deepEqual(fields(item), ["PurchaseOrder"]);
    assert.deepEqual(fields(item.PurchaseOrder), ["Status"]);
  });

  it("V2: * with a path keeps every property", async () => {
    const r = await get(
      `${s.v2}/${ITEMS}&$expand=PurchaseOrder&$select=*,PurchaseOrder/Status`,
    );
    const [row] = r.body.d.results;
    assert.ok(fields(row).includes("Material"));
    assert.deepEqual(fields(row.PurchaseOrder), ["Status"]);
  });
});

// OData 4.01 Part 1, 10.9 and 10.10: an expanded navigation is in the select-list, with what
// it selects or expands in parentheses, empty when it does neither; a level with only
// expanded navigations selects every property
describe("the context URL's select-list", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const context = async (query: string) => {
    const { status, body } = await get(`${s.v4}/PurchaseOrderSet${query}`);
    assert.equal(status, 200, JSON.stringify(body));
    return body["@odata.context"].replace(/^.*\$metadata#/, "");
  };

  for (const [query, expected] of [
    [
      "?$select=PurchaseOrderId&$expand=Items($expand=PurchaseOrder($select=Status))",
      "PurchaseOrderSet(PurchaseOrderId,Items(PurchaseOrder(Status)))",
    ],
    ["?$expand=Items($select=Material)", "PurchaseOrderSet(Items(Material))"],
    ["?$expand=Items", "PurchaseOrderSet(Items())"],
    [
      "?$expand=Items($expand=PurchaseOrder)",
      "PurchaseOrderSet(Items(PurchaseOrder()))",
    ],
    [
      "('4500000001')?$expand=Items($expand=PurchaseOrder($select=Status))",
      "PurchaseOrderSet(Items(PurchaseOrder(Status)))/$entity",
    ],
    ["?$select=Supplier", "PurchaseOrderSet(Supplier)"],
    ["", "PurchaseOrderSet"],
  ])
    it(`${query || "no $select or $expand"} -> ${expected}`, async () => {
      assert.equal(await context(query), expected);
    });
});
