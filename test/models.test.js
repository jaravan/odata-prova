const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { start, get } = require("./helpers");

// The example models under models/ must keep working: each loads, answers on every entity
// set in both versions, and has seed data.
const MODELS = path.join(__dirname, "..", "..", "models");
const names = fs
  .readdirSync(MODELS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(MODELS, d.name, "metadata.xml")))
  .map((d) => d.name);

for (const name of names) {
  describe(`models/${name}`, () => {
    let s;
    before(async () => { s = await start(path.join(MODELS, name)); });
    after(() => s.close());

    it("answers on every entity set in both versions, with data in some", async () => {
      let rows = 0;
      for (const set of Object.keys(s.model.entitySets)) {
        const v2 = await get(`${s.v2}/${set}`);
        const v4 = await get(`${s.v4}/${set}`);
        assert.equal(v2.status, 200, `v2 ${set}`);
        assert.equal(v4.status, 200, `v4 ${set}`);
        assert.equal(v2.body.d.results.length, v4.body.value.length, set);
        rows += v4.body.value.length;
      }
      assert.ok(rows > 0, "no seed data at all");
    });
  });
}

describe("models/Northwind links products to categories and suppliers", () => {
  let s;
  before(async () => { s = await start(path.join(MODELS, "Northwind")); });
  after(() => s.close());

  it("in V4 and V2", async () => {
    const v4 = (await get(`${s.v4}/Products(1)?$expand=Category,Supplier`)).body;
    assert.equal(v4.Category.CategoryName, "Beverages");
    assert.equal(v4.Supplier.CompanyName, "Exotic Liquids");
    const v2 = (await get(`${s.v2}/Products(1)?$expand=Category,Supplier`)).body.d;
    assert.equal(v2.Category.CategoryName, "Beverages");
    assert.equal(v2.Supplier.CompanyName, "Exotic Liquids");
  });
});
