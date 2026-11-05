// A property on its own: its raw value, a time to the digit its Precision keeps, and what a
// null one answers.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { batch, get, send, start, type TestServer } from "./helpers.ts";

const STAMPS = path.join(import.meta.dirname, "fixtures", "Stamps");
const BASE = "2025-01-01T00:00:00";

describe("a Precision past the millisecond", () => {
  let s: TestServer;
  before(async () => {
    s = await start(STAMPS);
    const row = { ID: 1, At: `${BASE}.1234567Z`, At3: `${BASE}.1234567Z` };
    assert.equal((await send("POST", `${s.v4}/Rs`, row)).status, 201);
    await send("POST", `${s.v4}/Rs`, { ID: 2, At: `${BASE}.1234568Z` });
    await send("POST", `${s.v4}/Rs`, { ID: 3, At: `${BASE}.5+01:00` });
  });
  after(() => s.close());

  const matches = async (filter: string) =>
    (
      await get(`${s.v4}/Rs?$select=ID&$filter=${encodeURIComponent(filter)}`)
    ).body.value.map((r: { ID: number }) => r.ID);

  it("every digit comes back", async () => {
    assert.equal((await get(`${s.v4}/Rs(1)`)).body.At, `${BASE}.1234567Z`);
  });

  it("a shorter Precision still shows what it holds", async () => {
    assert.equal((await get(`${s.v4}/Rs(1)`)).body.At3, `${BASE}.123Z`);
  });

  it("a zone moves the time, and pads it", async () => {
    assert.equal(
      (await get(`${s.v4}/Rs(3)`)).body.At,
      "2024-12-31T23:00:00.5000000Z",
    );
  });

  for (const [filter, ids] of [
    [`At eq ${BASE}.1234567Z`, [1]],
    [`At eq ${BASE}.1239999Z`, []],
    [`At gt ${BASE}.1234567Z`, [2]],
    [`At gt ${BASE}.1234Z`, [1, 2]],
    [`At lt ${BASE}.1234568Z`, [1, 3]],
    [`At3 eq ${BASE}.123Z`, [1]],
  ] as const)
    it(`${filter} tells them apart`, async () => {
      assert.deepEqual(await matches(filter), ids);
    });

  it("$orderby tells them apart", async () => {
    const { body } = await get(`${s.v4}/Rs?$orderby=At desc&$select=ID`);
    assert.deepEqual(
      body.value.map((r: { ID: number }) => r.ID),
      [2, 1, 3],
    );
  });
});

describe("a property's value", () => {
  let s: TestServer;
  before(async () => {
    s = await start(STAMPS);
    await send("POST", `${s.v4}/Rs`, { ID: 1, S: "x", B: "AQID" });
    await send("POST", `${s.v4}/Rs`, { ID: 2 });
  });
  after(() => s.close());

  for (const root of ["v4", "v2"] as const)
    it(`/$value of a binary is its bytes, in ${root}`, async () => {
      const res = await fetch(`${s[root]}/Rs(1)/B/$value`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.deepEqual(
        new Uint8Array(await res.arrayBuffer()),
        Uint8Array.of(1, 2, 3),
      );
    });

  it("text stays text", async () => {
    const res = await fetch(`${s.v4}/Rs(1)/S/$value`);
    assert.match(res.headers.get("content-type")!, /text\/plain/);
    assert.equal(await res.text(), "x");
  });

  for (const url of ["Rs(2)/S", "Rs(2)/S/$value", "Rs(2)/B/$value"])
    it(`${url}, null, is a 204 in V4`, async () => {
      const res = await fetch(`${s.v4}/${url}`);
      assert.equal(res.status, 204);
      assert.equal(await res.text(), "");
    });

  it("a value is still a 200", async () => {
    assert.equal((await fetch(`${s.v4}/Rs(1)/S`)).status, 200);
  });
});

describe("what a URL can't mean", () => {
  let s: TestServer;
  before(async () => {
    s = await start(STAMPS);
  });
  after(() => s.close());

  it("two values for one key say so, not that 50 is a property", async () => {
    const { status, body } = await get(`${s.v4}/Rs(500,1)`);
    assert.equal(status, 400);
    assert.doesNotMatch(body.error.message, /is not a key property/);
    assert.match(body.error.message, /Name=value/);
  });

  for (const option of ["$top", "$skip"])
    it(`${option} with no value is a 400`, async () => {
      assert.equal((await get(`${s.v4}/Rs?${option}=`)).status, 400);
      assert.equal((await get(`${s.v2}/Rs?${option}=`)).status, 400);
    });
});

describe("a binary's /$value in a $batch", () => {
  it("is base64, and says so", async () => {
    const s = await start(STAMPS);
    try {
      await send("POST", `${s.v4}/Rs`, { ID: 1, B: "//79" });
      const { text } = await batch(s.v4, [
        { method: "GET", url: "Rs(1)/B/$value" },
      ]);
      assert.match(text, /Content-Type: application\/octet-stream/i);
      assert.match(text, /Content-Transfer-Encoding: base64\r\n/i);
      assert.match(text, /\/\/79/);
    } finally {
      await s.close();
    }
  });
});
