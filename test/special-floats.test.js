const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { start, get, batch, batchResponses } = require("./helpers");

// Edm.Double values INF, -INF and NaN: JSON has no such numbers, so OData spells them as strings
describe("INF, -INF and NaN", () => {
  let s;
  before(async () => (s = await start(path.join(__dirname, "fixtures", "SpecialFloats"))));
  after(() => s.close());

  const values = async () => (await get(`${s.v4}/Ms?$select=V&$orderby=ID`)).body.value.map((m) => m.V);

  it("are written as strings on V4 and V2", async () => {
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
    const v2 = await get(`${s.v2}/Ms?$orderby=ID`, { accept: "application/json" });
    assert.deepEqual(v2.body.d.results.map((m) => m.V), ["INF", "-INF", "NaN", 1.5]);
  });

  it("as a property and its raw value", async () => {
    assert.equal((await get(`${s.v4}/Ms(1)/V`)).body.value, "INF");
    assert.equal((await get(`${s.v4}/Ms(3)/V/$value`)).body, "NaN");
  });

  it("survive a changeset that rolls back", async () => {
    const r = await batch(s.v4, [[
      { method: "PATCH", url: "Ms(4)", body: { V: 2.5 } },
      { method: "PATCH", url: "Ms(4)", body: { V: "not a number" } },
    ]]);
    assert.ok(batchResponses(r.text).some((p) => p.status >= 400));
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
  });
});
