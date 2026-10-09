const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { start, get, send } = require("./helpers");

// Order and Item both keyed by ID, and no ReferentialConstraint: the join comes from naming.
// Items 1, 2, 3 belong to orders 1, 1, 2 (Item.OrderID). Matching the source's key names alone
// would join Order.ID to Item.ID; the convention <Source>ID finds the real foreign key.
for (const version of ["V2", "V4"]) {
  describe(`join by naming, both types keyed by ID (${version} metadata)`, () => {
    let s;
    before(
      async () =>
        (s = await start(
          path.join(__dirname, "fixtures", `NamingJoin${version}`),
        )),
    );
    after(() => s.close());

    it("joins on the foreign key named after the other side, both ways, and logs it", () => {
      const nav = (type, name) =>
        s.model.entityTypes[`S.${type}`].navigations[name];
      assert.deepEqual(nav("Order", "Items").join, [["ID", "OrderID"]]);
      assert.deepEqual(nav("Item", "Order").join, [["OrderID", "ID"]]);
      assert.equal(nav("Order", "Items").partner, "Order");
      assert.equal(nav("Order", "Items").cascadeDelete, false);
      assert.deepEqual(s.model.warnings, [
        "navigation joined by naming: Order.Items on Order.ID = Item.OrderID (no ReferentialConstraint)",
        "navigation joined by naming: Item.Order on Item.OrderID = Order.ID (no ReferentialConstraint)",
      ]);
    });

    it("an order's items are the ones that point at it", async () => {
      const items = async (order) =>
        (await get(`${s.v4}/Orders(${order})/Items?$select=ID`)).body.value.map(
          (i) => i.ID,
        );
      assert.deepEqual(await items(1), [1, 2]);
      assert.deepEqual(await items(2), [3]);
      assert.equal((await get(`${s.v4}/Items(3)/Order`)).body.ID, 2);
    });

    it("deleting an order deletes neither its items nor anything else", async () => {
      assert.equal((await send("DELETE", `${s.v4}/Orders(2)`)).status, 204);
      assert.equal((await get(`${s.v4}/Items`)).body.value.length, 3);
    });
  });
}
