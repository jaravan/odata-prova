const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, get } = require("./helpers");

describe("unsupported query options are rejected, not ignored", () => {
  let s;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("$apply on both protocols -> 501 in the protocol's error shape", async () => {
    const v4 = await get(
      `${s.v4}/PurchaseOrderSet?$apply=groupby((Status),aggregate(TotalAmount with sum as Total))`,
    );
    assert.equal(v4.status, 501);
    assert.match(v4.body.error.message, /\$apply is not supported/);

    const v2 = await get(`${s.v2}/PurchaseOrderSet?$apply=groupby((Status))`);
    assert.equal(v2.status, 501);
    assert.match(v2.body.error.message.value, /\$apply is not supported/);
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
