import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, PO_MODEL, type TestServer } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

// $expand=*: every navigation of the type, as if each were named
describe("$expand=*", () => {
  let s: TestServer;
  before(async () => (s = await start(PO_MODEL)));
  after(() => s.close());

  it("expands every navigation, the same as naming them", async () => {
    const all = await get(`${s.v4}/PurchaseOrderItemSet?$top=2&$expand=*`);
    const named = await get(
      `${s.v4}/PurchaseOrderItemSet?$top=2&$expand=PurchaseOrder`,
    );
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.value, named.body.value);
    assert.ok(all.body.value[0].PurchaseOrder.PurchaseOrderId);
  });

  it("at a nested level, and next to a navigation named with its own options", async () => {
    const nested = await get(
      `${s.v4}/PurchaseOrderSet('4500000001')?$select=PurchaseOrderId&$expand=Items($expand=*)`,
    );
    assert.equal(nested.status, 200);
    for (const item of nested.body.Items)
      assert.equal(item.PurchaseOrder.PurchaseOrderId, "4500000001");
    const both = await get(
      `${s.v4}/PurchaseOrderSet('4500000001')?$expand=*,Items($top=1)`,
    );
    assert.equal(both.body.Items.length, 1);
  });

  it("*/$ref and *($levels=n) are a 501: $ref and $levels in $expand aren't supported", async () => {
    for (const expand of ["*/$ref", "*($levels=2)"]) {
      const r = await get(`${s.v4}/PurchaseOrderSet?$expand=${expand}`);
      assert.equal(r.status, 501, expand);
      assert.match(
        r.body.error.message,
        /is not supported: only \* on its own/,
      );
    }
  });

  it("with $apply, on the entities it leaves", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderSet?$apply=filter(PurchaseOrderId eq '4500000001')&$expand=*`,
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.value[0].Items.length > 0);
  });
});

describe("$expand=* with draft and disabled navigations", () => {
  it("includes a draft's SiblingEntity and DraftAdministrativeData", async () => {
    const s = await start(path.join(FIXTURES, "DraftSrv"));
    try {
      const r = await get(`${s.v4}/Books?$top=1&$expand=*`);
      assert.equal(r.status, 200);
      const [book] = r.body.value;
      for (const nav of [
        "chapters",
        "author",
        "SiblingEntity",
        "DraftAdministrativeData",
      ])
        assert.ok(nav in book, nav);
    } finally {
      await s.close();
    }
  });

  it("leaves out a navigation the server can't serve, rather than fail", async () => {
    const s = await start(path.join(FIXTURES, "Disabled"));
    try {
      const r = await get(`${s.v4}/Students?$expand=*`);
      assert.equal(r.status, 200);
      assert.equal("Advisor" in r.body.value[0], false);
      // Named on its own, it's still the 501 that says why
      assert.equal((await get(`${s.v4}/Students?$expand=Advisor`)).status, 501);
    } finally {
      await s.close();
    }
  });
});
