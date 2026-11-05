// What isn't valid is a 400, not a request read as another one: $orderby=Status foo isn't
// $orderby=Status, and 2025-13-01 isn't a date.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { get, start, type TestServer } from "./helpers.ts";

const statusOf = async (url: string) => (await get(encodeURI(url))).status;

describe("query options that can't be read", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const orders = () => `${s.v4}/PurchaseOrderSet`;

  for (const query of [
    "$orderby=TotalAmount eq 5",
    "$orderby=Status foo",
    "$orderby=Status desc asc",
    "$orderby=Status mul 2",
    "$orderby=Status asc,Currency sideways",
    "$apply=orderby(Status foo)",
    "$expand=Items($orderby=Material foo)",
    "$count=x",
    "$count=1",
    "$expand=Items($count=x)",
  ]) {
    it(`${query} is a 400`, async () => {
      assert.equal(await statusOf(`${orders()}?${query}`), 400);
    });
  }

  it("V2's $orderby is read the same way", async () => {
    assert.equal(
      await statusOf(`${s.v2}/PurchaseOrderSet?$orderby=Status foo`),
      400,
    );
  });

  for (const query of [
    "$orderby=Status",
    "$orderby=Status asc",
    "$orderby=Status desc",
    "$orderby=Status DESC",
    "$orderby=Status  desc , Currency",
    "$count=true",
    "$count=false",
    "$count=",
    "$expand=Items($count=true)",
  ]) {
    it(`${query} is still fine`, async () => {
      assert.equal(await statusOf(`${orders()}?${query}`), 200);
    });
  }

  it("$count=TRUE is true, not false", async () => {
    const { body } = await get(`${orders()}?$count=TRUE`);
    assert.equal(typeof body["@odata.count"], "number");
  });

  it("$orderby=Status DESC still sorts down", async () => {
    const ids = async (query: string) =>
      (await get(encodeURI(`${orders()}?${query}&$select=Status`))).body.value;
    assert.deepEqual(
      await ids("$orderby=Status DESC"),
      await ids("$orderby=Status desc"),
    );
  });

  it("V2's $inlinecount is allpages or none", async () => {
    const root = `${s.v2}/PurchaseOrderSet`;
    assert.equal(await statusOf(`${root}?$inlinecount=x`), 400);
    assert.equal(await statusOf(`${root}?$inlinecount=ALLPAGES`), 400);
    assert.equal(await statusOf(`${root}?$inlinecount=none`), 200);
    const { body } = await get(`${root}?$inlinecount=allpages`);
    assert.equal(typeof body.d.__count, "string");
  });
});
