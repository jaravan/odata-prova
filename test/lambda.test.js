const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { start, get } = require("./helpers");

const TRIPPIN = path.join(__dirname, "fixtures", "real", "TripPin");

// The lambda operators any/all in $filter. Fiori Elements V4 generates them for filter fields
// on a to-many navigation, e.g. Items/any(i:i/Material eq 'X').
describe("$filter lambda operators", () => {
  let s, orders;
  const ids = async (filter) => {
    const r = await get(`${s.v4}/PurchaseOrderSet?$select=PurchaseOrderId&$filter=${encodeURIComponent(filter)}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.value.map((o) => o.PurchaseOrderId);
  };
  // The orders whose items pass `test`, worked out from the data itself
  const where = (test) => orders.filter(test).map((o) => o.PurchaseOrderId);

  before(async () => {
    s = await start();
    orders = (await get(`${s.v4}/PurchaseOrderSet?$select=PurchaseOrderId&$expand=Items`)).body.value;
  });
  after(() => s.close());

  it("any with a predicate on the item", async () => {
    assert.deepEqual(await ids("Items/any(i:i/Material eq 'MAT-1001')"), where((o) => o.Items.some((i) => i.Material === "MAT-1001")));
    assert.deepEqual(await ids("Items/any(i:i/Material ne null)"), where((o) => o.Items.length > 0));
  });

  it("any() without a predicate: there is at least one item", async () => {
    assert.deepEqual(await ids("Items/any()"), where((o) => o.Items.length > 0));
  });

  it("all: every item passes, so also an order without items", async () => {
    const tonnes = await ids("Items/all(i:i/Unit eq 'TO')");
    assert.deepEqual(tonnes, where((o) => o.Items.every((i) => i.Unit === "TO")));
    assert.ok(tonnes.includes("4500000002"));
    assert.ok(!tonnes.includes("4500000001"));
  });

  it("the multi-value filter Fiori Elements sends, combined with not and outer paths", async () => {
    assert.deepEqual(
      await ids("(Items/any(i0:i0/Material eq 'MAT-1001') or Items/any(i1:i1/Material eq 'MAT-2001'))"),
      ["4500000001", "4500000002"],
    );
    assert.deepEqual(await ids("not Items/any(i:i/Material eq 'MAT-1001')"), where((o) => !o.Items.some((i) => i.Material === "MAT-1001")));
    // A path without the variable, or with $it, is read off the order
    assert.deepEqual(await ids("Items/any(i:i/PurchaseOrderId eq $it/PurchaseOrderId and PurchaseOrderId eq '4500000002')"), ["4500000002"]);
    assert.deepEqual(await ids("$it/PurchaseOrderId eq '4500000001'"), ["4500000001"]);
  });

  // i/PurchaseOrder/Items leads from an item back to all items of its order
  it("nested: any in any, all in any", async () => {
    assert.deepEqual(
      await ids("Items/any(i:i/PurchaseOrder/Items/any(j:j/Material eq 'MAT-1001'))"),
      where((o) => o.Items.some((i) => i.Material === "MAT-1001")),
    );
    assert.deepEqual(
      await ids("Items/any(i:i/PurchaseOrder/Items/all(j:j/Unit eq 'TO'))"),
      where((o) => o.Items.length > 0 && o.Items.every((i) => i.Unit === "TO")),
    );
  });

  it("nested: the inner predicate reads the outer variable, and $it is still the order", async () => {
    // Another item of the same order than i: orders with at least two items
    assert.deepEqual(
      await ids("Items/any(i:i/PurchaseOrder/Items/any(j:j/ItemPosition ne i/ItemPosition))"),
      where((o) => o.Items.length >= 2),
    );
    assert.deepEqual(
      await ids("Items/any(i:i/PurchaseOrder/Items/any(j:j/PurchaseOrderId eq $it/PurchaseOrderId and $it/PurchaseOrderId eq '4500000002'))"),
      ["4500000002"],
    );
  });

  it("works in $count", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet/$count?$filter=${encodeURIComponent("Items/any(i:i/Material eq 'MAT-1001')")}`);
    assert.equal(r.body, "1");
  });

  it("mistakes are 400s", async () => {
    for (const filter of ["Supplier/any(s:s eq 'x')", "Items/all()", "Items/any(i:i/Nope eq 1)", "Items/any(i/x:true)"]) {
      const r = await get(`${s.v4}/PurchaseOrderSet?$filter=${encodeURIComponent(filter)}`);
      assert.equal(r.status, 400, filter);
    }
  });
});

describe("$filter lambda operators over collection-valued properties", () => {
  let s;
  const users = async (filter) =>
    (await get(`${s.v4}/People?$select=UserName&$filter=${encodeURIComponent(filter)}`)).body.value.map((p) => p.UserName);
  before(async () => { s = await start(TRIPPIN); });
  after(() => s.close());

  it("primitive items: the variable alone is the item", async () => {
    assert.deepEqual(await users("Emails/any(e:endswith(e,'contoso.com'))"), ["russellwhyte"]);
    assert.deepEqual(await users("Emails/any(e:e eq 'nobody@example.com')"), []);
  });

  it("complex items: variable/field", async () => {
    assert.deepEqual(await users("AddressInfo/any(a:a/Address eq '187 Suffolk Ln.')"), ["russellwhyte"]);
  });
});
