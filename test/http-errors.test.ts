import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  ORDER,
  type Reply,
  type TestServer,
} from "./helpers.ts";

// Requests the service never gets to see: they must still get an OData error, not Express's
// HTML page with a stack trace.
describe("bad requests get an OData error, not an HTML page", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("a malformed escape in the URL -> 400 in each protocol's error shape", async () => {
    const v4 = await get(`${s.v4}/PurchaseOrderSet%E0%A4%A`);
    assert.equal(v4.status, 400);
    assert.match(v4.headers.get("content-type") ?? "", /json/);
    assert.match(v4.body.error.message, /Malformed URL/);

    const v2 = await get(`${s.v2}/PurchaseOrderSet%E0%A4%A`);
    assert.equal(v2.status, 400);
    assert.match(v2.body.error.message.value, /Malformed URL/);
  });

  it("a path is decoded once: %25zz is the text %zz, not a malformed escape", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet%25zz`);
    assert.equal(r.status, 404);
    assert.match(r.body.error.message, /PurchaseOrderSet%zz/);
  });

  it("a path with characters no segment has -> 400, never read as another path", async () => {
    for (const tail of [
      "(",
      "PurchaseOrderSet('4500000001')Items",
      "PurchaseOrderSet(1)(2)",
    ]) {
      const r = await send("PUT", `${s.v4}/${tail}`, {});
      assert.equal(r.status, 400, tail);
      assert.match(
        r.body.error.message,
        /The resource path can't be read from/,
      );
    }
    // Slashes in a row still read as one
    assert.equal(
      (await get(`${s.v4}/PurchaseOrderSet('4500000001')//Items`)).status,
      200,
    );
  });

  it("a body that is not JSON -> 400, without a stack trace", async () => {
    const res = await fetch(`${s.v4}/PurchaseOrderSet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /JSON/);
    assert.doesNotMatch(body.error.message, /node_modules|\n\s+at /);
  });

  it("a malformed URL inside $batch fails that part only", async () => {
    const r = await batch(s.v2, [
      { method: "GET", url: "PurchaseOrderSet%E0%A4%A" },
      { method: "GET", url: "PurchaseOrderSet('4500000001')" },
    ]);
    const [bad, good] = batchResponses(r.text);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message.value, /Malformed URL/);
    assert.equal(good.status, 200);
  });
});

// The spec: a service fails a request with a system query option it doesn't know, rather
// than answer as if it weren't there ($TOP=1 answering every row)
describe("query options the server doesn't know are refused", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("an unknown or misspelt $ option -> 400 naming it, on both protocols", async () => {
    for (const q of ["$foo=1", "$TOP=1", "$fliter=Status eq 'Open'"]) {
      const v4 = await get(`${s.v4}/PurchaseOrderSet?${q}`);
      assert.equal(v4.status, 400, q);
      assert.match(v4.body.error.message, /Unknown system query option \$/);
      const v2 = await get(`${s.v2}/PurchaseOrderSet?${q}`);
      assert.equal(v2.status, 400, q);
    }
  });

  it("the other protocol's option -> 400 ($count in V2, $inlinecount in V4)", async () => {
    assert.equal(
      (await get(`${s.v4}/PurchaseOrderSet?$inlinecount=allpages`)).status,
      400,
    );
    assert.equal(
      (await get(`${s.v2}/PurchaseOrderSet?$count=true`)).status,
      400,
    );
  });

  it("custom options, without a $, are left alone: sap-client, sap-language, search", async () => {
    for (const base of [s.v4, s.v2])
      assert.equal(
        (
          await get(
            `${base}/PurchaseOrderSet?sap-client=100&sap-language=EN&saml2=disabled`,
          )
        ).status,
        200,
      );
  });

  it("a $top or $skip that isn't a whole number -> 400 (1.5, 2abc)", async () => {
    for (const q of ["$top=1.5", "$top=2abc", "$skip=1e2", "$top= 1"]) {
      const r = await get(`${s.v4}/PurchaseOrderSet?${q}`);
      assert.equal(r.status, 400, q);
    }
  });
});

describe("/$value of an entity, which the server has no media for", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("-> 501, not the entity's JSON", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet('4500000001')/$value`);
    assert.equal(r.status, 501);
    assert.match(r.body.error.message, /\$value/);
    assert.equal(
      (await get(`${s.v2}/PurchaseOrderSet('4500000001')/$value`)).status,
      501,
    );
  });

  it("a property's /$value still answers its raw value", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet('4500000001')/Status/$value`);
    assert.equal(r.status, 200);
    assert.equal(typeof r.body, "string");
  });
});

// Every error has a code a client can branch on: its status's, or a more specific one
describe("error codes", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  // V2 and V4 both have it next to the message
  const code = (r: Reply) => r.body.error.code as string;

  it("by status, in V4 and V2", async () => {
    for (const [url, status, expected] of [
      [`${s.v4}/Nope`, 404, "NotFound"],
      [`${s.v2}/Nope`, 404, "NotFound"],
      [`${s.v4}/PurchaseOrderSet?$filter=Nope eq 1`, 400, "BadRequest"],
      [`${s.v4}/PurchaseOrderSet?$format=xml`, 501, "NotImplemented"],
      [`${s.v4}/PurchaseOrderSet%E0%A4%A`, 400, "BadRequest"],
    ] as const) {
      const r = await get(url);
      assert.equal(r.status, status, url);
      assert.equal(code(r), expected, url);
    }
    const method = await send("DELETE", `${s.v4}/PurchaseOrderSet`);
    assert.equal(code(method), "MethodNotAllowed");
  });

  it("more specific where a client can act on it", async () => {
    const missing = await send("POST", `${s.v4}/PurchaseOrderSet`, {
      PurchaseOrderId: "9",
    });
    assert.equal(code(missing), "RequiredProperty");
    const invalid = await send("POST", `${s.v4}/PurchaseOrderSet`, {
      ...ORDER,
      PurchaseOrderId: "9",
      TotalAmount: "lots",
    });
    assert.equal(code(invalid), "InvalidValue");
    const duplicate = await send("POST", `${s.v2}/PurchaseOrderSet`, {
      ...ORDER,
      PurchaseOrderId: "4500000001",
    });
    assert.equal(duplicate.status, 409);
    assert.equal(code(duplicate), "DuplicateKey");
    const expired = await get(`${s.v4}/PurchaseOrderSet?$deltatoken=nope`);
    assert.equal(code(expired), "DeltaLinkExpired");
  });
});

describe("a Location for a key no header can hold as it is", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("is percent-encoded, and leads to the entity", async () => {
    for (const id of ["a\nb", "é ü"]) {
      const r = await send("POST", `${s.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: id,
      });
      assert.equal(r.status, 201);
      const location = r.headers.get("location")!;
      assert.match(location, /^[\x21-\x7E]+$/);
      const back = await get(`${s.base}${location}`);
      assert.equal(back.status, 200);
      assert.equal(back.body.PurchaseOrderId, id);
    }
  });
});
