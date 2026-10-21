import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  start,
  get,
  batch,
  batchResponses,
  ORDER,
  ITEM,
  PO_MODEL,
  type TestServer,
} from "./helpers.ts";

describe("$batch", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("V2: mixed reads and an atomic changeset, UI5-style relative URLs", async () => {
    const r = await batch(s.v2, [
      { method: "GET", url: "PurchaseOrderSet?$top=1&$select=PurchaseOrderId" },
      [
        {
          method: "POST",
          url: "PurchaseOrderSet",
          body: {
            ...ORDER,
            PurchaseOrderId: "B001",
            Supplier: "Batch",
            Status: "New",
          },
        },
        {
          method: "MERGE",
          url: "PurchaseOrderSet('B001')",
          body: { Status: "Open" },
        },
      ],
      { method: "GET", url: "PurchaseOrderSet('B001')/Status" },
    ]);
    assert.equal(r.status, 200);
    assert.match(
      r.headers.get("content-type") ?? "",
      /multipart\/mixed; ?boundary=batchresponse_/,
    );
    assert.equal(r.headers.get("dataserviceversion"), "2.0");
    const parts = batchResponses(r.text);
    assert.deepEqual(
      parts.map((p) => p.status),
      [200, 201, 204, 200],
    );
    assert.equal(parts[0].body.d.results.length, 1);
    assert.equal(parts[1].headers["dataserviceversion"], "2.0");
    assert.deepEqual(parts[3].body, { d: { Status: "Open" } });
  });

  it("V2: a failing changeset member rolls the changeset back and reports one error", async () => {
    const before = (await get(`${s.v2}/PurchaseOrderSet/$count`)).body;
    const r = await batch(s.v2, [
      [
        {
          method: "POST",
          url: "PurchaseOrderSet",
          body: { ...ORDER, PurchaseOrderId: "B002" },
        },
        {
          method: "POST",
          url: "PurchaseOrderSet",
          body: { ...ORDER, PurchaseOrderId: "B002" },
        }, // duplicate -> 409
      ],
    ]);
    const parts = batchResponses(r.text);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].status, 409);
    assert.equal((await get(`${s.v2}/PurchaseOrderSet/$count`)).body, before);
  });

  it("V4: Content-ID references inside a changeset, OData-Version headers", async () => {
    const r = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "PurchaseOrderSet",
          contentId: "1",
          body: {
            ...ORDER,
            PurchaseOrderId: "B003",
            Supplier: "Ref",
            Status: "New",
          },
        },
        {
          method: "POST",
          url: "$1/Items",
          contentId: "2",
          body: { ...ITEM, ItemPosition: "0001", Material: "M" },
        },
        {
          method: "PATCH",
          url: "$1",
          body: { Status: "Open" },
          headers: { Prefer: "return=minimal" },
        },
      ],
      {
        method: "GET",
        url: "PurchaseOrderSet('B003')?$expand=Items($select=PurchaseOrderId,Material)&$select=Status",
      },
    ]);
    assert.equal(r.headers.get("odata-version"), "4.0");
    const parts = batchResponses(r.text);
    assert.deepEqual(
      parts.map((p) => p.status),
      [201, 201, 204, 200],
    );
    assert.equal(parts[0].headers["content-id"], "1");
    assert.equal(parts[0].headers["odata-version"], "4.0");
    assert.equal(parts[1].body.PurchaseOrderId, "B003");
    assert.equal(parts[2].headers["preference-applied"], "return=minimal");
    assert.deepEqual(parts[3].body.Items, [
      { PurchaseOrderId: "B003", Material: "M" },
    ]);
    assert.equal(parts[3].body.Status, "Open");
  });

  it("V4: an unknown Content-ID reference fails the changeset", async () => {
    const r = await batch(s.v4, [
      [{ method: "POST", url: "$9/Items", body: {} }],
    ]);
    const parts = batchResponses(r.text);
    assert.equal(parts[0].status, 400);
    assert.match(
      parts[0].body.error.message,
      /Unknown Content-ID reference \$9/,
    );
  });

  it("rejects a $batch without a boundary", async () => {
    const res = await fetch(`${s.v4}/$batch`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x",
    });
    assert.equal(res.status, 400);
  });
});

describe("a JSON $batch", () => {
  it("is a 501 that says to send it as multipart", async () => {
    const s = await start(PO_MODEL);
    try {
      const r = await fetch(`${s.v4}/$batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [{ id: "1", method: "GET", url: "PurchaseOrderSet" }],
        }),
      });
      assert.equal(r.status, 501);
      const body = (await r.json()) as { error: { message: string } };
      assert.match(
        body.error.message,
        /A JSON \$batch \(OData 4\.01\) is not supported: send it as multipart\/mixed, as UI5 does/,
      );
      // Without a boundary otherwise, still a 400
      const plain = await fetch(`${s.v4}/$batch`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "x",
      });
      assert.equal(plain.status, 400);
    } finally {
      await s.close();
    }
  });
});
