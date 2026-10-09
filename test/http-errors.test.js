import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, batch, batchResponses } from "./helpers.js";

// Requests the service never gets to see: they must still get an OData error, not Express's
// HTML page with a stack trace.
describe("bad requests get an OData error, not an HTML page", () => {
  let s;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("a malformed escape in the URL -> 400 in each protocol's error shape", async () => {
    const v4 = await get(`${s.v4}/PurchaseOrderSet%E0%A4%A`);
    assert.equal(v4.status, 400);
    assert.match(v4.headers.get("content-type"), /json/);
    assert.match(v4.body.error.message, /Malformed URL/);

    const v2 = await get(`${s.v2}/PurchaseOrderSet%E0%A4%A`);
    assert.equal(v2.status, 400);
    assert.match(v2.body.error.message.value, /Malformed URL/);
  });

  it("an escape that is only malformed once decoded (%25zz) -> 400", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet%25zz`);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /Malformed URL/);
  });

  it("a body that is not JSON -> 400, without a stack trace", async () => {
    const res = await fetch(`${s.v4}/PurchaseOrderSet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /JSON/);
    assert.doesNotMatch(body.error.message, /node_modules|\n\s+at /);
  });

  it("a malformed URL inside $batch fails that part only", async () => {
    const r = await batch(s.v2, [
      { method: "GET", url: "PurchaseOrderSet%E0%A4%A" },
      { method: "GET", url: "PurchaseOrderSet('4500000001')" },
    ]);
    const [bad, good] = batchResponses(r.text);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message.value, /Malformed URL/);
    assert.equal(good.status, 200);
  });
});
