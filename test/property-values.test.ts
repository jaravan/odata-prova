// A property on its own: its raw value, a time to the digit its Precision keeps, and what a
// null one answers.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start, type TestServer } from "./helpers.ts";

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
