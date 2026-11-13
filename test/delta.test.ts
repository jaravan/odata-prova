import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  start,
  get,
  send,
  ORDER,
  PO_MODEL,
  type TestServer,
  withoutIds,
} from "./helpers.ts";

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
    assert.deepEqual(withoutIds(r.body.value), [
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

  it("V2: $deltatoken is V4's -> 501; SAP's is !deltatoken", async () => {
    const r = await get(`${s.v2}/PurchaseOrderSet?$deltatoken=abc`);
    assert.equal(r.status, 501);
    assert.match(
      r.body.error.message.value,
      /\$deltatoken is not supported in OData V2/,
    );
    const expired = await get(`${s.v2}/PurchaseOrderSet?!deltatoken='nope'`);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, "DeltaLinkExpired");
  });
});

// SAP Gateway's V2 delta queries: d.__delta with !deltatoken='...', and the deleted entities
// in d.__deleted
describe("V2 delta links", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start();
  });
  afterEach(() => s.close());

  it("Prefer: odata.track-changes gets d.__delta, and following it the changes", async () => {
    const r = await get(`${s.v2}/PurchaseOrderSet?$select=Status`, TRACK);
    assert.equal(r.headers.get("preference-applied"), "odata.track-changes");
    const link = r.body.d.__delta as string;
    assert.match(
      link,
      /^\/odata\/v2\/T\/PurchaseOrderSet\?\$select=Status&!deltatoken='[\w-]+'$/,
    );

    await send("PATCH", `${s.v4}/${order(2)}`, { Status: "Completed" });
    await send("POST", `${s.v4}/PurchaseOrderSet`, {
      ...ORDER,
      PurchaseOrderId: "4500000006",
    });
    await send("DELETE", `${s.v4}/${order(5)}`);

    const delta = await get(s.base + link);
    assert.equal(delta.status, 200);
    assert.deepEqual(
      delta.body.d.results.map((o: { Status: string }) => o.Status),
      ["Completed", "Open"],
    );
    assert.deepEqual(delta.body.d.__deleted, [
      {
        __metadata: {
          id: `/odata/v2/T/${order(5)}`,
          uri: `/odata/v2/T/${order(5)}`,
          type: "com.example.po.PurchaseOrder",
        },
        PurchaseOrderId: "4500000005",
      },
    ]);
    // The next link starts from here
    const next = await get(s.base + delta.body.d.__delta);
    assert.deepEqual(next.body.d.results, []);
    assert.deepEqual(next.body.d.__deleted, []);
  });

  it('an entity set with sap:change-tracking="true" gets one without asking', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delta-v2-"));
    fs.cpSync(PO_MODEL, dir, { recursive: true });
    const file = path.join(dir, "metadata.xml");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(
          '<EntitySet Name="PurchaseOrderSet"',
          '<EntitySet sap:change-tracking="true" Name="PurchaseOrderSet"',
        ),
    );
    const tracked = await start(dir);
    try {
      const orders = await get(`${tracked.v2}/PurchaseOrderSet`);
      assert.match(orders.body.d.__delta, /!deltatoken='/);
      const items = await get(`${tracked.v2}/PurchaseOrderItemSet`);
      assert.equal(items.body.d.__delta, undefined);
      // V4 has no sap: attributes: it asks with Prefer
      const v4 = await get(`${tracked.v4}/PurchaseOrderSet`);
      assert.equal(v4.body["@odata.deltaLink"], undefined);
    } finally {
      await tracked.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A $filter can reach other rows: what it matched changes with them, and the entity with it
describe("a delta when a related row changes what the $filter matches", () => {
  const FAMILIES = path.join(import.meta.dirname, "fixtures", "Families");
  let s: TestServer;
  beforeEach(async () => {
    s = await start(FAMILIES);
    await send("POST", `${s.v4}/Ps`, { ID: 1, I1: 9 });
    await send("POST", `${s.v4}/Ks`, { ID: 10, PID: 1, I1: 7 });
  });
  afterEach(() => s.close());

  const tracked = async (url: string) =>
    s.base +
    (await get(`${s.v4}/${encodeURI(url)}`, TRACK)).body["@odata.deltaLink"];

  it("the kid that made the parent match is deleted", async () => {
    const link = await tracked("Ps?$filter=Kids/any()");
    await send("DELETE", `${s.v4}/Ks(10)`);
    const { body } = await get(link);
    assert.equal(body.value.length, 1);
    assert.equal(body.value[0].reason, "changed");
    assert.match(body.value[0].id, /Ps\(1\)/);
  });

  it("the kid stops matching a lambda", async () => {
    const link = await tracked("Ps?$filter=Kids/any(k:k/I1 gt 5)");
    await send("PATCH", `${s.v4}/Ks(10)`, { I1: 1 });
    const { body } = await get(link);
    assert.equal(body.value[0].reason, "changed");
  });

  it("the parent changes under a path through it", async () => {
    const link = await tracked("Ks?$filter=Parent/I1 eq 9");
    await send("PATCH", `${s.v4}/Ps(1)`, { I1: 8 });
    const { body } = await get(link);
    assert.equal(body.value[0].reason, "changed");
    assert.match(body.value[0].id, /Ks\(10\)/);
  });

  it("an entity that starts to match is in the delta, unchanged itself", async () => {
    const link = await tracked("Ks?$filter=Parent/I1 eq 8");
    await send("PATCH", `${s.v4}/Ps(1)`, { I1: 8 });
    const { body } = await get(link);
    assert.deepEqual(
      body.value.map((k: { ID: number }) => k.ID),
      [10],
    );
  });

  it("an entity changed and leaving the filter's reach is one entry", async () => {
    const link = await tracked("Ps?$filter=Kids/any()");
    await send("PATCH", `${s.v4}/Ps(1)`, { I1: 1 });
    await send("DELETE", `${s.v4}/Ks(10)`);
    const { body } = await get(link);
    assert.equal(body.value.length, 1);
    assert.equal(body.value[0].reason, "changed");
  });

  it("a parent deleted after its last kid is still reported deleted: it matched when the link was read", async () => {
    const link = await tracked("Ps?$filter=Kids/any()");
    await send("DELETE", `${s.v4}/Ks(10)`);
    await send("DELETE", `${s.v4}/Ps(1)`);
    const { body } = await get(link);
    assert.equal(body.value[0].reason, "deleted");
  });

  it("an entity that matches throughout isn't in the delta", async () => {
    const link = await tracked("Ps?$filter=Kids/any()");
    await send("POST", `${s.v4}/Ks`, { ID: 11, PID: 1, I1: 7 });
    assert.deepEqual((await get(link)).body.value, []);
  });

  it("the next delta link compares against what matched when it was handed out", async () => {
    const first = await tracked("Ps?$filter=Kids/any()");
    await send("DELETE", `${s.v4}/Ks(10)`);
    const { body } = await get(first);
    const next = s.base + body["@odata.deltaLink"];
    assert.deepEqual((await get(next)).body.value, []);
    await send("POST", `${s.v4}/Ks`, { ID: 12, PID: 1, I1: 7 });
    const again = await get(next);
    assert.deepEqual(
      again.body.value.map((p: { ID: number }) => p.ID),
      [1],
    );
  });

  it("V2 lists it in __deleted", async () => {
    const r = await get(
      `${s.v2}/Ks?$filter=${encodeURIComponent("Parent/I1 eq 9")}`,
      TRACK,
    );
    await send("PATCH", `${s.v4}/Ps(1)`, { I1: 8 });
    const { body } = await get(s.base + r.body.d.__delta);
    assert.equal(body.d.__deleted.length, 1);
  });

  it("a delta link with another $filter has expired", async () => {
    const link = await tracked("Ps?$filter=Kids/any()");
    const edited = link.replace("Kids/any()", "ID eq 1");
    assert.notEqual(edited, link);
    assert.equal((await get(edited)).status, 410);
  });
});
