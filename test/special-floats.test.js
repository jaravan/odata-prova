import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send, batch, batchResponses } from "./helpers.js";

// Edm.Double values INF, -INF and NaN: JSON has no such numbers, so OData spells them as strings
describe("INF, -INF and NaN", () => {
  let s;
  before(
    async () =>
      (s = await start(
        path.join(import.meta.dirname, "fixtures", "SpecialFloats"),
      )),
  );
  after(() => s.close());

  const values = async () =>
    (await get(`${s.v4}/Ms?$select=V&$orderby=ID`)).body.value.map((m) => m.V);

  it("are written as strings on V4 and V2", async () => {
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
    const v2 = await get(`${s.v2}/Ms?$orderby=ID`, {
      accept: "application/json",
    });
    assert.deepEqual(
      v2.body.d.results.map((m) => m.V),
      ["INF", "-INF", "NaN", 1.5],
    );
  });

  it("as a property and its raw value", async () => {
    assert.equal((await get(`${s.v4}/Ms(1)/V`)).body.value, "INF");
    assert.equal((await get(`${s.v4}/Ms(3)/V/$value`)).body, "NaN");
  });

  it("survive a changeset that rolls back", async () => {
    const r = await batch(s.v4, [
      [
        { method: "PATCH", url: "Ms(4)", body: { V: 2.5 } },
        { method: "PATCH", url: "Ms(4)", body: { V: "not a number" } },
      ],
    ]);
    assert.ok(batchResponses(r.text).some((p) => p.status >= 400));
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
  });

  it("only these three: a key every object inherits is a 400", async () => {
    for (const V of ["toString", "constructor", "__proto__"]) {
      const r = await send("PATCH", `${s.v4}/Ms(4)`, { V });
      assert.equal(r.status, 400, V);
    }
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
  });
});
