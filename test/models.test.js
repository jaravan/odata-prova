import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start, get } from "./helpers.js";

// The example models under examples/ must keep working: each loads, answers on every entity
// set in both versions, and has data, from seed files or generated as the server does by
// default (MOCK_ROWS=20; TripPin has no seed files).
const MODELS = path.join(import.meta.dirname, "..", "examples");
const names = fs
  .readdirSync(MODELS, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      fs.existsSync(path.join(MODELS, d.name, "metadata.xml")),
  )
  .map((d) => d.name);

for (const name of names) {
  describe(`examples/${name}`, () => {
    let s;
    before(async () => {
      s = await start(path.join(MODELS, name), { mockRows: 20 });
    });
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
      assert.ok(rows > 0, "no data at all");
    });
  });
}

describe("examples/Northwind links products to categories and suppliers", () => {
  let s;
  before(async () => {
    s = await start(path.join(MODELS, "Northwind"));
  });
  after(() => s.close());

  it("in V4 and V2", async () => {
    const v4 = (await get(`${s.v4}/Products(1)?$expand=Category,Supplier`))
      .body;
    assert.equal(v4.Category.CategoryName, "Beverages");
    assert.equal(v4.Supplier.CompanyName, "Exotic Liquids");
    const v2 = (await get(`${s.v2}/Products(1)?$expand=Category,Supplier`)).body
      .d;
    assert.equal(v2.Category.CategoryName, "Beverages");
    assert.equal(v2.Supplier.CompanyName, "Exotic Liquids");
  });
});
