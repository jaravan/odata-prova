import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, type TestServer } from "./helpers.ts";

// The orders' suppliers in test/fixtures/PurchaseOrderSrv: Acme Components Ltd (Open),
// Nordic Steel AB (Approved), Pacific Electronics Inc (Completed), Global Packaging GmbH
// (Open), Sunrise Logistics Co (Cancelled)
describe("$search: terms, phrases, AND, OR, NOT and parentheses", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const ids = async (search: string) => {
    const r = await get(
      `${s.v4}/PurchaseOrderSet?$search=${encodeURIComponent(search)}&$select=PurchaseOrderId&$orderby=PurchaseOrderId`,
    );
    assert.equal(r.status, 200, `${search}: ${JSON.stringify(r.body)}`);
    return r.body.value.map((o: { PurchaseOrderId: string }) =>
      o.PurchaseOrderId.slice(-1),
    );
  };

  it("one term, any case, in any string property", async () => {
    assert.deepEqual(await ids("nordic"), ["2"]);
    assert.deepEqual(await ids("OPEN"), ["1", "4"]);
  });

  it("terms side by side: each must match (AND), as Fiori Elements sends them quoted", async () => {
    assert.deepEqual(await ids("open gmbh"), ["4"]);
    assert.deepEqual(await ids('"open" "gmbh"'), ["4"]);
    assert.deepEqual(await ids("open AND acme"), ["1"]);
  });

  it("a phrase in quotes matches as written", async () => {
    assert.deepEqual(await ids('"steel ab"'), ["2"]);
    assert.deepEqual(await ids('"ab steel"'), []);
  });

  it("OR, NOT and parentheses, with NOT before AND before OR", async () => {
    assert.deepEqual(await ids("nordic OR pacific"), ["2", "3"]);
    assert.deepEqual(await ids("open NOT acme"), ["4"]);
    assert.deepEqual(await ids("NOT open"), ["2", "3", "5"]);
    assert.deepEqual(await ids("acme OR nordic AND steel"), ["1", "2"]);
    assert.deepEqual(await ids("(acme OR nordic) AND open"), ["1"]);
  });

  it("a search it can't read -> 400", async () => {
    for (const bad of [
      '"unterminated',
      "(open",
      "open)",
      "open AND",
      "NOT",
      "OR open",
      '""',
    ]) {
      const r = await get(
        `${s.v4}/PurchaseOrderSet?$search=${encodeURIComponent(bad)}`,
      );
      assert.equal(r.status, 400, bad);
      assert.match(r.body.error.message, /\$search/);
    }
  });

  it("the same in $apply's search()", async () => {
    const r = await get(
      `${s.v4}/PurchaseOrderSet?$apply=${encodeURIComponent("search(open NOT acme)")}&$select=PurchaseOrderId`,
    );
    assert.deepEqual(r.body.value, [{ PurchaseOrderId: "4500000004" }]);
  });
});

// SAP Gateway's basic search, which UI5's V2 model sends as the custom option search=
describe("V2: search=, as SAP Gateway reads it", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("filters the collection as V4's $search does", async () => {
    const r = await get(
      `${s.v2}/PurchaseOrderSet?search=nordic&$select=Supplier&$inlinecount=allpages`,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.d.results.map((o: { Supplier: string }) => o.Supplier),
      ["Nordic Steel AB"],
    );
    assert.equal(r.body.d.__count, "1");
  });

  it("several words: each must match", async () => {
    const r = await get(
      `${s.v2}/PurchaseOrderSet?search=open%20gmbh&$select=Supplier`,
    );
    assert.deepEqual(
      r.body.d.results.map((o: { Supplier: string }) => o.Supplier),
      ["Global Packaging GmbH"],
    );
  });

  it("and in /$count", async () => {
    const r = await get(`${s.v2}/PurchaseOrderSet/$count?search=open`);
    assert.equal(r.body, "2");
  });
});
