import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { start, get, send, ORDER, type TestServer } from "./helpers.ts";

// Delta links, on the PurchaseOrderSrv fixture's 5 orders (1 and 4 are Open, 3 is Completed)
const TRACK = { prefer: "odata.track-changes" };
const order = (n: number) => `PurchaseOrderSet('450000000${n}')`;

describe("delta links", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start();
  });
  afterEach(() => s.close());

  // The delta link of a tracked read of url, followed: what changed since
  const deltaLink = async (url: string, headers = {}) => {
    const r = await get(url, { ...TRACK, ...headers });
    assert.equal(r.status, 200);
    return s.base + r.body["@odata.deltaLink"];
  };

  it("Prefer: odata.track-changes gets a delta link, and is confirmed", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet?$select=Status`, TRACK);
    assert.equal(r.headers.get("preference-applied"), "odata.track-changes");
    assert.match(
      r.body["@odata.deltaLink"],
      /^\/odata\/v4\/T\/PurchaseOrderSet\?\$select=Status&\$deltatoken=[\w-]+$/,
    );
    const untracked = await get(`${s.v4}/PurchaseOrderSet`);
    assert.equal(untracked.body["@odata.deltaLink"], undefined);
    assert.equal(untracked.headers.get("preference-applied"), null);
  });

  it("the delta: entities added or changed, and $deletedEntity entries", async () => {
    const link = await deltaLink(`${s.v4}/PurchaseOrderSet`);
    const none = await get(link);
    assert.deepEqual(none.body.value, []);

    await send("POST", `${s.v4}/PurchaseOrderSet`, {
      ...ORDER,
      PurchaseOrderId: "4500000006",
    });
    await send("PATCH", `${s.v4}/${order(2)}`, { Status: "Completed" });
    await send("DELETE", `${s.v4}/${order(5)}`);

    const r = await get(link);
    assert.equal(r.status, 200);
    assert.equal(
      r.body["@odata.context"],
      "/odata/v4/T/$metadata#PurchaseOrderSet/$delta",
    );
    assert.deepEqual(
      r.body.value.map((e: Record<string, string>) => [
        e.PurchaseOrderId ?? e.id,
        e.Status ?? e.reason,
      ]),
      [
        ["4500000002", "Completed"],
        ["4500000006", "Open"],
        ["/odata/v4/T/PurchaseOrderSet('4500000005')", "deleted"],
      ],
    );
    assert.equal(
      r.body.value[2]["@odata.context"],
      "/odata/v4/T/$metadata#PurchaseOrderSet/$deletedEntity",
    );

    // The new delta link starts from here
    const next = await get(s.base + r.body["@odata.deltaLink"]);
    assert.deepEqual(next.body.value, []);
  });

  it("with a $filter: entities that start or stop matching it", async () => {
    const link = await deltaLink(
      `${s.v4}/PurchaseOrderSet?$filter=Status eq 'Open'&$select=Status`,
    );
    await send("PATCH", `${s.v4}/${order(1)}`, { Status: "Approved" });
    await send("PATCH", `${s.v4}/${order(3)}`, { Status: "Open" });
    await send("PATCH", `${s.v4}/${order(2)}`, { Status: "Cancelled" });
    await send("DELETE", `${s.v4}/${order(5)}`); // not Open: not the client's

    const r = await get(link);
    assert.deepEqual(r.body.value, [
      { Status: "Open" }, // order 3, with the $select of the link
      {
        "@odata.context":
          "/odata/v4/T/$metadata#PurchaseOrderSet/$deletedEntity",
        id: `/odata/v4/T/${order(1)}`,
        reason: "changed",
      },
    ]);
  });

  it("with server-driven paging: on the last page only", async () => {
    await s.close();
    s = await start(undefined, { pageSize: 2 });
    const first = await get(`${s.v4}/PurchaseOrderSet`, TRACK);
    assert.ok(first.body["@odata.nextLink"]);
    assert.equal(first.body["@odata.deltaLink"], undefined);
    const last = await get(`${s.v4}/PurchaseOrderSet?$skiptoken=4`, TRACK);
    assert.equal(last.body["@odata.nextLink"], undefined);
    assert.match(
      last.body["@odata.deltaLink"],
      /PurchaseOrderSet\?\$deltatoken=/,
    );

    const both = await get(`${s.v4}/PurchaseOrderSet?$skiptoken=4`, {
      prefer: "odata.track-changes, odata.maxpagesize=1",
    });
    assert.equal(
      both.headers.get("preference-applied"),
      "odata.maxpagesize=1, odata.track-changes",
    );
  });

  it("not for a query a delta can't answer, or a navigation", async () => {
    for (const url of [
      `${s.v4}/PurchaseOrderSet?$top=2`,
      `${s.v4}/PurchaseOrderSet?$apply=groupby((Status))`,
      `${s.v4}/${order(1)}/Items`,
    ]) {
      const r = await get(url, TRACK);
      assert.equal(r.status, 200, url);
      assert.equal(r.body["@odata.deltaLink"], undefined, url);
      assert.equal(r.headers.get("preference-applied"), null, url);
    }
  });

  it("an unknown or expired token -> 410; not on an entity -> 400", async () => {
    assert.equal(
      (await get(`${s.v4}/PurchaseOrderSet?$deltatoken=nope`)).status,
      410,
    );
    // A token is for the entity set it was given for
    const link = await deltaLink(`${s.v4}/PurchaseOrderSet`);
    const token = new URL(link).searchParams.get("$deltatoken");
    assert.equal(
      (await get(`${s.v4}/PurchaseOrderItemSet?$deltatoken=${token}`)).status,
      410,
    );
    assert.equal(
      (await get(`${s.v4}/${order(1)}?$deltatoken=${token}`)).status,
      400,
    );
    // Only the latest 100 are kept
    for (let i = 0; i < 100; i++) await get(`${s.v4}/PurchaseOrderSet`, TRACK);
    assert.equal((await get(link)).status, 410);
  });

  it("V2 has none: $deltatoken -> 501, and the preference is ignored", async () => {
    const r = await get(`${s.v2}/PurchaseOrderSet?$deltatoken=abc`);
    assert.equal(r.status, 501);
    assert.match(
      r.body.error.message.value,
      /\$deltatoken is not supported in OData V2/,
    );
    const tracked = await get(`${s.v2}/PurchaseOrderSet`, TRACK);
    assert.equal(tracked.headers.get("preference-applied"), null);
  });
});
