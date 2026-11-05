// What isn't valid is a 400, not a request read as another one: $orderby=Status foo isn't
// $orderby=Status, and 2025-13-01 isn't a date.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { toInternal } from "../lib/types.ts";
import { get, send, ORDER, start, type TestServer } from "./helpers.ts";

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

describe("values that aren't one", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const filter = (expression: string) =>
    statusOf(`${s.v4}/PurchaseOrderSet?$filter=${expression}`);

  for (const expression of [
    "OrderDate gt 2025-13-01",
    "OrderDate gt 2025-02-30",
    "OrderDate gt 2025-00-10",
    "round('a') eq 1",
    "floor(Status) eq 1",
    "ceiling(true) eq 1",
    "Status add 1 eq 2",
    "1 sub Status eq 2",
    "OrderDate add 1 eq 2",
  ]) {
    it(`$filter=${expression} is a 400`, async () => {
      assert.equal(await filter(expression), 400);
    });
  }

  for (const expression of [
    "OrderDate gt 2024-02-29",
    "round('1.5') eq 2",
    "round(TotalAmount) gt 0",
    "TotalAmount add 1 gt 0",
    "round(null) eq 1",
    "Status add null eq 2",
    "substring(Status,1) eq 'x'",
  ]) {
    it(`$filter=${expression} is still fine`, async () => {
      assert.equal(await filter(expression), 200);
    });
  }

  it("a time of PT says nothing", () => {
    assert.throws(() => toInternal("PT", "Edm.TimeOfDay"), /Invalid/);
    assert.equal(toInternal("PT1H", "Edm.TimeOfDay"), "01:00:00");
  });

  for (const offset of ["+99:99", "+24:00", "-24:00", "+00:60", "+23:60"]) {
    it(`a time zone of ${offset} is a 400 in a body`, async () => {
      const { status } = await send("POST", `${s.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: "ZONE",
        OrderDate: `2025-01-01T00:00:00${offset}`,
      });
      assert.equal(status, 400);
    });
  }

  for (const offset of ["+23:59", "-23:59", "+14:00", "-00:00"]) {
    it(`a time zone of ${offset} is one`, async () => {
      const { status, body } = await send("POST", `${s.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: `Z${offset}`,
        OrderDate: `2025-06-15T12:00:00${offset}`,
      });
      assert.equal(status, 201, JSON.stringify(body));
    });
  }
});
