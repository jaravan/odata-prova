// An $expand of something that isn't a navigation is a 400, on both protocols, whether or not
// any row comes back for it to be used on.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start, type TestServer } from "./helpers.ts";

describe("$expand is checked against the type", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const ORDER = "PurchaseOrderSet('4500000001')";
  const NONE = "$filter=Status eq 'none'".replaceAll(" ", "%20");

  for (const query of [
    "PurchaseOrderSet?$expand=Nope",
    `PurchaseOrderSet?$expand=Nope&${NONE}`,
    `${ORDER}?$expand=Nope`,
    "PurchaseOrderSet?$expand=Items/Nope",
    `PurchaseOrderSet?$expand=Items/Nope&${NONE}`,
    "PurchaseOrderSet?$expand=Items,Nope",
    "PurchaseOrderSet?$expand=Items($orderby=true)",
    "PurchaseOrderSet?$expand=Status",
    `${ORDER}/Items?$expand=Nope`,
  ]) {
    it(`V2: ${query} is a 400`, async () => {
      assert.equal((await get(`${s.v2}/${query}`)).status, 400);
    });
  }

  for (const query of [
    "PurchaseOrderSet?$expand=Nope",
    `PurchaseOrderSet?$expand=Nope&${NONE}`,
    `${ORDER}?$expand=Nope`,
    "PurchaseOrderSet?$expand=Items($expand=Nope)",
    `PurchaseOrderSet?$expand=Items($expand=Nope)&${NONE}`,
    "PurchaseOrderSet?$expand=Status",
  ]) {
    it(`V4: ${query} is a 400`, async () => {
      assert.equal((await get(`${s.v4}/${query}`)).status, 400);
    });
  }

  it("names what it couldn't find, and on what", async () => {
    const { body } = await get(`${s.v2}/PurchaseOrderSet?$expand=Items/Nope`);
    assert.match(
      body.error.message.value,
      /^Nope is not a navigation property of PurchaseOrderItem$/,
    );
  });

  for (const query of [
    "PurchaseOrderSet?$expand=Items",
    "PurchaseOrderSet?$expand=Items/PurchaseOrder",
    `PurchaseOrderSet?$expand=Items&${NONE}`,
    "PurchaseOrderSet?$expand=",
    `${ORDER}?$expand=Items`,
  ]) {
    it(`V2: ${query} still works`, async () => {
      assert.equal((await get(`${s.v2}/${query}`)).status, 200);
    });
  }

  it("V2: a $select of a complex member is no navigation to go through", async () => {
    const shapes = await start(
      path.join(import.meta.dirname, "fixtures", "Shapes"),
    );
    try {
      const r = await get(`${shapes.v2}/Items?$select=Addr/City`);
      assert.equal(r.status, 400);
    } finally {
      await shapes.close();
    }
  });
});
