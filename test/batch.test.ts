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
  withoutIds,
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
    assert.deepEqual(withoutIds(parts[3].body.Items), [
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

  it("a boundary's text inside a body doesn't end the part: a boundary starts a line", async () => {
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

describe("$batch: parsing the multipart body", () => {
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

  it("a ? inside a query value is part of the value", async () => {
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

  it("a changeset with no closing delimiter fails, and the part after it still runs", async () => {
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

  it("every part runs when the closing delimiter is there", async () => {
    const res = await raw(
      `${part("Docs?$top=1")}${part("Docs?$top=1")}--b--\r\n`,
    );
    assert.equal(batchResponses(await res.text()).length, 2);
  });

  it("$constructor, $toString and $__proto__ are unknown Content-ID references", async () => {
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

describe("$batch: a request line", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const statuses = (text: string) => batchResponses(text).map((r) => r.status);
  const raw = async (line: string) => {
    const res = await fetch(`${s.v4}/$batch`, {
      method: "POST",
      headers: { "content-type": "multipart/mixed; boundary=b" },
      body: `--b\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n${line}\r\n\r\n\r\n--b--\r\n`,
    });
    return batchResponses(await res.text())[0];
  };

  for (const url of [
    "PurchaseOrderSet?$orderby=TotalAmount desc",
    "PurchaseOrderSet?$filter=Status eq 'Open'",
    "PurchaseOrderSet('4500000001') /Items",
  ]) {
    it(`a space in the URL is a 400, not a shorter URL: ${url}`, async () => {
      const [part] = batchResponses(
        (await batch(s.v4, [{ method: "GET", url }])).text,
      );
      assert.equal(part.status, 400);
      assert.match(part.body.error.message, /space/);
    });
  }

  it("on V2 too", async () => {
    const res = await batch(s.v2, [
      { method: "GET", url: "PurchaseOrderSet?$orderby=TotalAmount desc" },
    ]);
    assert.deepEqual(statuses(res.text), [400]);
  });

  it("the other parts of the batch still run", async () => {
    const res = await batch(s.v4, [
      { method: "GET", url: "PurchaseOrderSet?$top=1" },
      { method: "GET", url: "PurchaseOrderSet?$orderby=Status desc" },
      { method: "GET", url: "PurchaseOrderSet?$top=1" },
    ]);
    assert.deepEqual(statuses(res.text), [200, 400, 200]);
  });

  it("in a changeset it fails the changeset, and undoes what ran", async () => {
    const res = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "PurchaseOrderSet",
          body: { ...ORDER, PurchaseOrderId: "SPACE" },
        },
        {
          method: "PATCH",
          url: "PurchaseOrderSet('SPACE') x",
          body: { Status: "New" },
        },
      ],
    ]);
    assert.deepEqual(statuses(res.text), [400]);
    assert.equal((await get(`${s.v4}/PurchaseOrderSet('SPACE')`)).status, 404);
  });

  it("%20 in the URL is decoded to a space", async () => {
    const res = await batch(s.v4, [
      { method: "GET", url: "PurchaseOrderSet?$orderby=TotalAmount%20desc" },
    ]);
    const [part] = batchResponses(res.text);
    const amounts = part.body.value.map((r: { TotalAmount: unknown }) =>
      Number(r.TotalAmount),
    );
    assert.deepEqual(
      amounts,
      amounts.toSorted((a: number, b: number) => b - a),
    );
  });

  it("a space in a body is left alone", async () => {
    const res = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "PurchaseOrderSet",
          body: { ...ORDER, PurchaseOrderId: "BODY", Supplier: "two words" },
        },
      ],
    ]);
    assert.deepEqual(statuses(res.text), [201]);
  });

  it("the HTTP version may be left out", async () => {
    assert.equal((await raw("GET PurchaseOrderSet?$top=1")).status, 200);
  });

  it("several spaces between the method, URL and version count as one", async () => {
    assert.equal(
      (await raw("GET  PurchaseOrderSet?$top=1  HTTP/1.1")).body.value.length,
      1,
    );
  });

  it("a third word that is not an HTTP version belongs to the URL", async () => {
    assert.equal((await raw("GET PurchaseOrderSet x")).status, 400);
  });
});

describe("$batch: the service's own $ resources", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const one = async (root: string, url: string) =>
    batchResponses((await batch(root, [{ method: "GET", url }])).text)[0];

  for (const version of ["v4", "v2"] as const) {
    it(`${version}: $metadata answers as it does outside a $batch`, async () => {
      const direct = await (await fetch(`${s[version]}/$metadata`)).text();
      const part = await one(s[version], "$metadata");
      assert.equal(part.status, 200);
      assert.match(part.headers["content-type"], /application\/xml/);
      assert.equal(part.body, direct);
    });
  }

  it("$metadata takes a query", async () => {
    assert.equal((await one(s.v4, "$metadata?sap-language=EN")).status, 200);
  });

  it("its full URL means the same", async () => {
    assert.equal(
      (await one(s.v4, `${new URL(s.v4).pathname}/$metadata`)).status,
      200,
    );
  });

  for (const url of [
    "$all",
    "$crossjoin(PurchaseOrderSet,PurchaseOrderItemSet)",
    "$entity?$id=PurchaseOrderSet('4500000001')",
  ]) {
    it(`${url} gets the answer it gets outside a $batch`, async () => {
      const direct = await fetch(`${s.v4}/${url}`);
      const part = await one(s.v4, url);
      assert.equal(part.status, direct.status);
      assert.deepEqual(part.body, await direct.json());
    });
  }

  it("a $batch in a $batch runs nothing", async () => {
    const res = await batch(s.v4, [
      { method: "POST", url: "$batch", body: {} },
    ]);
    assert.equal(batchResponses(res.text)[0].status, 404);
  });

  it("a Content-ID named metadata can still be referenced as $metadata", async () => {
    const res = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "PurchaseOrderSet",
          contentId: "metadata",
          body: { ...ORDER, PurchaseOrderId: "NAMED" },
        },
        { method: "PATCH", url: "$metadata", body: { Status: "New" } },
      ],
    ]);
    assert.equal(batchResponses(res.text)[0].status, 201);
    const { body } = await get(`${s.v4}/PurchaseOrderSet('NAMED')`);
    assert.equal(body.Status, "New");
  });

  for (const url of ["$metadata2", "$batchs", "$9", "$all(1)"]) {
    it(`${url} is still an unknown Content-ID`, async () => {
      const part = await one(s.v4, url);
      assert.equal(part.status, 400);
      assert.match(part.body.error.message, /Unknown Content-ID/);
    });
  }
});
