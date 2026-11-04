import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  start,
  get,
  send,
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

  it("a body holding the boundary's text is one part: a boundary starts a line", async () => {
    // The helpers' outer boundary is batch_test, its changesets' changeset_<i>
    const r = await batch(s.v4, [
      [
        {
          method: "PATCH",
          url: "PurchaseOrderSet('4500000001')",
          body: { Supplier: "a --batch_test b --changeset_0 c" },
        },
      ],
    ]);
    const parts = batchResponses(r.text);
    assert.deepEqual(
      parts.map((p) => p.status),
      [204],
    );
    const after = await get(
      `${s.v4}/PurchaseOrderSet('4500000001')?$select=Supplier`,
    );
    assert.equal(after.body.Supplier, "a --batch_test b --changeset_0 c");
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

describe("$batch: reading what was sent", () => {
  let s: TestServer;
  before(
    async () =>
      (s = await start(path.join(import.meta.dirname, "fixtures", "OddKeys"))),
  );
  after(() => s.close());

  const raw = (body: string) =>
    fetch(`${s.v4}/$batch`, {
      method: "POST",
      headers: { "content-type": "multipart/mixed; boundary=b" },
      body,
    });
  const part = (url: string) =>
    `--b\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nGET ${url} HTTP/1.1\r\n\r\n\r\n`;

  it("a ? in a query's value is part of it", async () => {
    await send("POST", `${s.v4}/Docs`, { No: "q" });
    const res = await batch(s.v4, [
      { method: "GET", url: "Docs?$filter=No%20eq%20'%3Fq'" },
      { method: "GET", url: "Docs?$filter=No%20eq%20'?q'&$select=No" },
    ]);
    const [encoded, plain] = batchResponses(res.text);
    assert.equal(encoded.body.value.length, 1);
    assert.deepEqual(
      plain.body.value,
      encoded.body.value.map((r: { No: string }) => ({ No: r.No })),
    );
  });

  it("no closing delimiter is a 400, and nothing ran", async () => {
    const res = await raw(
      `--b\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nPOST Docs HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"No":"cut"}\r\n`,
    );
    assert.equal(res.status, 400);
    assert.equal((await get(`${s.v4}/Docs('cut')`)).status, 404);
  });

  it("a changeset without one fails alone", async () => {
    const res = await raw(
      `--b\r\nContent-Type: multipart/mixed; boundary=cs\r\n\r\n--cs\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nPOST Docs HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"No":"cs"}\r\n--b\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nGET Docs('%231') HTTP/1.1\r\n\r\n\r\n--b--\r\n`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      batchResponses(await res.text()).map((r) => r.status),
      [400, 200],
    );
    assert.equal((await get(`${s.v4}/Docs('cs')`)).status, 404);
  });

  it("every part runs when it does close", async () => {
    const res = await raw(
      `${part("Docs?$top=1")}${part("Docs?$top=1")}--b--\r\n`,
    );
    assert.equal(batchResponses(await res.text()).length, 2);
  });

  it("a Content-ID named like what objects inherit is no reference", async () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const res = await batch(s.v4, [
        [{ method: "PATCH", url: `$${name}`, body: { Text: "x" } }],
      ]);
      const [reply] = batchResponses(res.text);
      assert.equal(reply.status, 400, name);
      assert.equal(
        reply.body.error.message,
        `Unknown Content-ID reference $${name}`,
      );
    }
  });

  it("__proto__ can be a Content-ID", async () => {
    const res = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "Docs",
          contentId: "__proto__",
          body: { No: "p" },
        },
        { method: "PATCH", url: "$__proto__", body: { Text: "x" } },
      ],
    ]);
    assert.deepEqual(
      batchResponses(res.text).map((r) => r.status),
      [201, 204],
    );
  });
});
