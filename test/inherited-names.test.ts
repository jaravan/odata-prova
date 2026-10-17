import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start, get, PO_MODEL, type TestServer } from "./helpers.ts";

// Names every JavaScript object has (constructor, toString, __proto__) are no entity set,
// property or navigation of the service, unless its metadata declares them
describe("names from a request that every object has", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("are unknown, as any other name is", async () => {
    for (const [url, status] of [
      [`${s.v4}/constructor`, 404],
      [`${s.v4}/__proto__`, 404],
      [`${s.v4}/toString`, 404],
      [`${s.v2}/constructor`, 404],
      [`${s.v4}/PurchaseOrderSet('4500000001')/constructor`, 404],
      [`${s.v4}/PurchaseOrderSet('4500000001')/hasOwnProperty`, 404],
      [`${s.v4}/PurchaseOrderSet?$select=constructor`, 400],
      [`${s.v4}/PurchaseOrderSet?$filter=toString eq 1`, 400],
      [`${s.v4}/PurchaseOrderSet?$orderby=valueOf`, 400],
      [`${s.v4}/PurchaseOrderSet?$expand=constructor`, 400],
      [`${s.v4}/PurchaseOrderSet?$expand=__proto__`, 400],
      [`${s.v4}/PurchaseOrderSet?$apply=groupby((constructor))`, 400],
      [`${s.v4}/PurchaseOrderSet?$compute=toString as X`, 400],
      [`${s.v4}/PurchaseOrderSet(PurchaseOrderId='1',constructor='2')`, 400],
    ] as const) {
      const r = await get(url);
      assert.equal(r.status, status, url);
      assert.doesNotMatch(JSON.stringify(r.body), /native code/, url);
    }
  });

  it("__proto__ is no alias: it would set the rows' prototype", async () => {
    for (const query of [
      "$compute=1 as __proto__",
      "$apply=aggregate($count as __proto__)",
    ]) {
      const r = await get(`${s.v4}/PurchaseOrderSet?${query}`);
      assert.equal(r.status, 400, query);
      assert.match(r.body.error.message, /alias/, query);
    }
  });
});

describe("a property the metadata names constructor", () => {
  let dir: string;
  let s: TestServer;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "inherited-"));
    fs.mkdirSync(path.join(dir, "data"));
    const rename = (file: string) =>
      fs.writeFileSync(
        path.join(dir, file),
        fs
          .readFileSync(path.join(PO_MODEL, file), "utf8")
          .replace(/\bSupplier\b/g, "constructor"),
      );
    rename("metadata.xml");
    rename(path.join("data", "PurchaseOrderSet.csv"));
    rename(path.join("data", "PurchaseOrderItemSet.csv"));
    s = await start(dir);
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("works like any other", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderSet?$select=constructor&$filter=constructor eq 'Nordic Steel AB'`,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [{ constructor: "Nordic Steel AB" }]);
    const one = await get(`${s.v4}/PurchaseOrderSet('4500000002')/constructor`);
    assert.equal(one.body.value, "Nordic Steel AB");
  });
});
