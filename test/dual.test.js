const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start, get, send, ORDER, ITEM } = require("./helpers");

describe("both protocols share one store", () => {
  let s;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("lists both service roots", async () => {
    const r = await get(`${s.base}/`);
    assert.deepEqual(r.body.services, [
      { odataVersion: "2.0", root: "/odata/v2/T/" },
      { odataVersion: "4.0", root: "/odata/v4/T/" },
    ]);
    assert.equal((await get(`${s.base}/healthz`)).body, "ok");
  });

  it("a write through V4 is visible through V2, and vice versa", async () => {
    const created = await send("POST", `${s.v4}/PurchaseOrderSet`, {
      ...ORDER,
      PurchaseOrderId: "D001",
      Supplier: "Dual",
      OrderDate: "2025-07-01",
      TotalAmount: "9.99",
      Items: [{ ...ITEM, ItemPosition: "0001", Material: "D" }],
    });
    assert.equal(created.status, 201);

    const viaV2 = await get(`${s.v2}/PurchaseOrderSet('D001')?$expand=Items`);
    assert.equal(viaV2.status, 200);
    assert.equal(viaV2.body.d.Supplier, "Dual");
    assert.equal(viaV2.body.d.OrderDate, `/Date(${Date.UTC(2025, 6, 1)})/`);
    assert.equal(viaV2.body.d.TotalAmount, "9.99");
    assert.equal(viaV2.body.d.Items.results[0].Material, "D");

    await send("MERGE", `${s.v2}/PurchaseOrderSet('D001')`, {
      Status: "Approved",
      OrderDate: "/Date(1767225600000)/",
    });
    const viaV4 = await get(
      `${s.v4}/PurchaseOrderSet('D001')?$select=Status,OrderDate`,
    );
    assert.equal(viaV4.body.Status, "Approved");
    assert.equal(viaV4.body.OrderDate, "2026-01-01");

    await send("DELETE", `${s.v4}/PurchaseOrderSet('D001')`);
    assert.equal((await get(`${s.v2}/PurchaseOrderSet('D001')`)).status, 404);
    assert.equal(
      (
        await get(
          `${s.v2}/PurchaseOrderItemSet(PurchaseOrderId='D001',ItemPosition='0001')`,
        )
      ).status,
      404,
    );
  });

  it("a protocol can be switched off", async () => {
    const { createApp } = require("../lib/app");
    const { app, services } = createApp({
      modelDir: require("./helpers").PO_MODEL,
      v2Path: "",
      v4Path: "/only/v4",
      log: () => {},
    });
    assert.equal(services.length, 1);
    const server = await new Promise((resolve) => {
      const x = app.listen(0, () => resolve(x));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal(
      (await get(`${base}/only/v4/PurchaseOrderSet/$count`)).status,
      200,
    );
    assert.equal(
      (await get(`${base}/odata/v2/PurchaseOrderSrv/PurchaseOrderSet`)).status,
      404,
    );
    await new Promise((resolve) => server.close(resolve));
  });
});
