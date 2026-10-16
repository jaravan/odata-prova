import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, get, type TestServer } from "./helpers.ts";

// Server-driven paging, on the 5 orders and 8 items of the PurchaseOrderSrv fixture

// Every page of a V4 collection, following @odata.nextLink from url
async function v4Pages(s: TestServer, url: string, headers = {}) {
  const pages = [];
  for (let next: string | undefined = url; next;) {
    const r = await get(next, headers);
    assert.equal(r.status, 200);
    pages.push(r.body);
    next = r.body["@odata.nextLink"] && s.base + r.body["@odata.nextLink"];
  }
  return pages;
}

const ids = (rows: { PurchaseOrderId: string }[]) =>
  rows.map((r) => r.PurchaseOrderId.slice(-1)).join("");

describe("server-driven paging with PAGE_SIZE", () => {
  let s: TestServer;
  before(async () => {
    s = await start(undefined, { pageSize: 2 });
  });
  after(() => s.close());

  it("V4: pages of 2 with @odata.nextLink, the count of every row on each", async () => {
    const pages = await v4Pages(
      s,
      `${s.v4}/PurchaseOrderSet?$orderby=PurchaseOrderId desc&$count=true`,
    );
    assert.deepEqual(
      pages.map((p) => ids(p.value)),
      ["54", "32", "1"],
    );
    assert.deepEqual(
      pages.map((p) => p["@odata.count"]),
      [5, 5, 5],
    );
    // The request's options as they came, and the offset of the next page
    assert.equal(
      pages[0]["@odata.nextLink"],
      "/odata/v4/T/PurchaseOrderSet?$orderby=PurchaseOrderId%20desc&$count=true&$skiptoken=2",
    );
  });

  it("V2: d.__next, with $inlinecount", async () => {
    const first = await get(
      `${s.v2}/PurchaseOrderSet?$inlinecount=allpages&$select=PurchaseOrderId`,
    );
    assert.equal(first.body.d.results.length, 2);
    assert.equal(first.body.d.__count, "5");
    assert.equal(
      first.body.d.__next,
      "/odata/v2/T/PurchaseOrderSet?$inlinecount=allpages&$select=PurchaseOrderId&$skiptoken=2",
    );
    const last = await get(
      `${s.v2}/PurchaseOrderSet?$inlinecount=allpages&$select=PurchaseOrderId&$skiptoken=4`,
    );
    assert.equal(ids(last.body.d.results), "5");
    assert.equal(last.body.d.__next, undefined);
  });

  it("pages within what $skip and $top ask for", async () => {
    const pages = await v4Pages(
      s,
      `${s.v4}/PurchaseOrderSet?$orderby=PurchaseOrderId&$skip=1&$top=3`,
    );
    assert.deepEqual(
      pages.map((p) => ids(p.value)),
      ["23", "4"],
    );
  });

  it("a last page that is full has no next link", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet?$top=4&$skiptoken=2`);
    assert.equal(r.body.value.length, 2);
    assert.equal(r.body["@odata.nextLink"], undefined);
  });

  it("a navigation's collection; an expanded one isn't paged", async () => {
    const pages = await v4Pages(
      s,
      `${s.v4}/PurchaseOrderSet('4500000001')/Items`,
    );
    assert.deepEqual(
      pages.map((p) => p.value.length),
      [2],
    );
    const expanded = await get(
      `${s.v4}/PurchaseOrderSet?$expand=Items&$filter=PurchaseOrderId le '4500000003'`,
    );
    assert.deepEqual(
      expanded.body.value.map((o: { Items: unknown[] }) => o.Items.length),
      [2, 2],
    );
    assert.ok(expanded.body["@odata.nextLink"]);
  });

  it("an $apply result", async () => {
    const pages = await v4Pages(
      s,
      `${s.v4}/PurchaseOrderSet?$apply=groupby((Status))&$orderby=Status`,
    );
    assert.deepEqual(
      pages.map((p) => p.value.map((r: { Status: string }) => r.Status)),
      [
        ["Approved", "Cancelled"],
        ["Completed", "Open"],
      ],
    );
  });

  it("$count and a single entity aren't paged", async () => {
    assert.equal((await get(`${s.v4}/PurchaseOrderSet/$count`)).body, "5");
    const one = await get(`${s.v4}/PurchaseOrderSet('4500000001')`);
    assert.equal(one.status, 200);
    assert.equal(one.body["@odata.nextLink"], undefined);
  });

  it("Prefer: odata.maxpagesize can make the pages smaller, not larger", async () => {
    const smaller = await get(`${s.v4}/PurchaseOrderSet`, {
      prefer: "odata.maxpagesize=1",
    });
    assert.equal(smaller.body.value.length, 1);
    assert.equal(
      smaller.headers.get("preference-applied"),
      "odata.maxpagesize=1",
    );
    const larger = await get(`${s.v4}/PurchaseOrderSet`, {
      prefer: "odata.maxpagesize=4",
    });
    assert.equal(larger.body.value.length, 2);
    assert.equal(larger.headers.get("preference-applied"), null);
  });

  it("a $skiptoken that isn't a whole number -> 400", async () => {
    assert.equal(
      (await get(`${s.v4}/PurchaseOrderSet?$skiptoken=abc`)).status,
      400,
    );
    assert.equal(
      (await get(`${s.v2}/PurchaseOrderSet?$skiptoken=-1`)).status,
      400,
    );
  });
});

describe("without PAGE_SIZE", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("every row, and no next link", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet`);
    assert.equal(r.body.value.length, 5);
    assert.equal(r.body["@odata.nextLink"], undefined);
  });

  it("a $skiptoken gives the rows from its offset on", async () => {
    const r = await get(
      `${s.v2}/PurchaseOrderSet?$orderby=PurchaseOrderId&$skiptoken=3`,
    );
    assert.equal(ids(r.body.d.results), "45");
  });

  it("V4: Prefer: odata.maxpagesize pages; V2 has no such preference", async () => {
    const prefer = { prefer: "odata.maxpagesize=2" };
    const pages = await v4Pages(
      s,
      `${s.v4}/PurchaseOrderSet?$orderby=PurchaseOrderId`,
      prefer,
    );
    assert.deepEqual(
      pages.map((p) => ids(p.value)),
      ["12", "34", "5"],
    );
    const v2 = await get(`${s.v2}/PurchaseOrderSet`, prefer);
    assert.equal(v2.body.d.results.length, 5);
    assert.equal(v2.body.d.__next, undefined);
  });
});
