import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get } from "./helpers.js";

describe("$select is checked against the type", () => {
  let s;
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
