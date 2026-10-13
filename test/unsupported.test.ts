import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, type TestServer } from "./helpers.ts";

describe("unsupported query options are rejected, not ignored", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("$apply on V2, which has none -> 501 in the protocol's error shape", async () => {
    const v2 = await get(`${s.v2}/PurchaseOrderSet?$apply=groupby((Status))`);
    assert.equal(v2.status, 501);
    assert.match(
      v2.body.error.message.value,
      /\$apply is not supported in OData V2/,
    );
  });

  it("$skiptoken and $compute -> 501; $format=json is fine, $format=xml is not", async () => {
    assert.equal(
      (await get(`${s.v2}/PurchaseOrderSet?$skiptoken=abc`)).status,
      501,
    );
    assert.equal(
      (
        await get(
          `${s.v4}/PurchaseOrderSet?$compute=TotalAmount mul 2 as Double`,
        )
      ).status,
      501,
    );
    assert.equal(
      (await get(`${s.v2}/PurchaseOrderSet?$format=json`)).status,
      200,
    );
    assert.equal(
      (await get(`${s.v2}/PurchaseOrderSet?$format=xml`)).status,
      501,
    );
  });
});
