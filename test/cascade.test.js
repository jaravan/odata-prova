const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { start, get, send } = require("./helpers");

// Product and ProductDetail share their key (ProductID) with no ReferentialConstraint: a
// one-to-one link, joined key to key, whose ends both cascade on delete
describe("cascading delete over a one-to-one link", () => {
  let s;
  before(
    async () => (s = await start(path.join(__dirname, "fixtures", "OneToOne"))),
  );
  after(() => s.close());

  it("both ends cascade", () => {
    const t = s.model.entityTypes;
    assert.equal(t["S.Product"].navigations.Detail.cascadeDelete, true);
    assert.equal(t["S.ProductDetail"].navigations.Product.cascadeDelete, true);
  });

  it("deletes each row once instead of cascading back and forth", async () => {
    assert.equal((await send("DELETE", `${s.v4}/Products(1)`)).status, 204);
    assert.deepEqual(
      (await get(`${s.v4}/Products`)).body.value.map((p) => p.ProductID),
      [2],
    );
    assert.deepEqual(
      (await get(`${s.v4}/ProductDetails`)).body.value.map((d) => d.ProductID),
      [2],
    );
  });
});
