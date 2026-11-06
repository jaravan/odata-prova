// What a request says twice, and a parameter that can't be null.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start, type TestServer } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

describe("an option given twice", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(FIXTURES, "OperationsV2"));
  });
  after(() => s.close());

  for (const url of [
    "PurchaseOrderSet?!deltatoken=1&!deltatoken=2",
    "PurchaseOrderSet?$top=1&$top=2",
    "GetStatusText?Status=a&Status=b",
  ])
    it(`${url} is a 400`, async () => {
      const { status, body } = await get(`${s.v2}/${url}`);
      assert.equal(status, 400);
      assert.match(body.error.message.value, /more than once/);
    });
});

describe("a parameter that can't be null", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(FIXTURES, "Params"));
  });
  after(() => s.close());

  for (const url of ["Lookup(ID=null)", "Score(d=null)", "Score()"])
    it(`${url} is a 400`, async () => {
      assert.equal((await get(`${s.v4}/${url}`)).status, 400);
    });

  for (const body of [{ n: null }, {}, { note: "x" }])
    it(`Approve with ${JSON.stringify(body)} is a 400`, async () => {
      assert.equal((await send("POST", `${s.v4}/Approve`, body)).status, 400);
    });

  it("given, or nullable, it works", async () => {
    assert.equal((await get(`${s.v4}/Lookup(ID=1)`)).status, 200);
    assert.equal((await get(`${s.v4}/Score(d=1.5)`)).status, 200);
    assert.equal((await get(`${s.v4}/Optional(d=null)`)).status, 200);
    assert.equal((await get(`${s.v4}/Optional()`)).status, 200);
    assert.equal((await send("POST", `${s.v4}/Approve`, { n: 1 })).status, 204);
    assert.equal(
      (await send("POST", `${s.v4}/Approve`, { n: 1, note: null })).status,
      204,
    );
  });
});

describe("overloaded functions", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(FIXTURES, "Params"));
  });
  after(() => s.close());

  for (const [url, expected] of [
    ["Ov(a=1)", ""],
    ["Ov(b='x')", 0],
    ["Ov()", false],
    ["Rs(1)/N.Bo(a=1)", ""],
    ["Rs(1)/N.Bo(b='x')", 0],
  ] as const)
    it(`${url} is the overload with those parameters`, async () => {
      const { status, body } = await get(`${s.v4}/${url}`);
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.value, expected);
    });

  it("a parameter no overload has is still a 400", async () => {
    assert.equal((await get(`${s.v4}/Ov(c=1)`)).status, 400);
    assert.equal((await get(`${s.v4}/Rs(1)/N.Bo(c=1)`)).status, 400);
  });
});

describe("overloads, in V2 and by type", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(FIXTURES, "Params"));
  });
  after(() => s.close());

  it("V2 reads the parameters from the query string", async () => {
    const res = await get(`${s.v2}/Ov?b='x'`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const text = JSON.stringify(res.body);
    assert.match(text, /:0\b/);
    const other = await get(`${s.v2}/Ov?a=1`);
    assert.equal(other.status, 200, JSON.stringify(other.body));
    assert.doesNotMatch(JSON.stringify(other.body), /:0\b/);
  });

  it("the overload nearest the entity's type wins", async () => {
    const { status, body } = await get(`${s.v4}/Ders(1)/N.Inh()`);
    assert.equal(status, 200);
    assert.equal(body.value, 0);
  });

  it("the base type gets its own", async () => {
    const { body } = await get(`${s.v4}/Rs(1)/N.Inh()`);
    assert.equal(body.value, "");
  });
});
