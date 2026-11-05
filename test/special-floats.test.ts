import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";

// A row of Ms: V is a number, or INF, -INF or NaN as a string
type M = { V: number | string };

// Edm.Double values INF, -INF and NaN: JSON has no such numbers, so OData spells them as strings
describe("INF, -INF and NaN", () => {
  let s: TestServer;
  before(
    async () =>
      (s = await start(
        path.join(import.meta.dirname, "fixtures", "SpecialFloats"),
      )),
  );
  after(() => s.close());

  const values = async () =>
    (await get(`${s.v4}/Ms?$select=V&$orderby=ID`)).body.value.map(
      (m: M) => m.V,
    );

  it("$filter: INF equals itself, NaN equals nothing", async () => {
    const ids = async (filter: string) =>
      (
        await get(`${s.v4}/Ms?$select=ID&$filter=${encodeURIComponent(filter)}`)
      ).body.value.map((m: { ID: number }) => m.ID);
    assert.deepEqual(await ids("V eq INF"), [1]);
    assert.deepEqual(await ids("V eq -INF"), [2]);
    assert.deepEqual(await ids("V eq NaN"), []);
    assert.deepEqual(await ids("V lt INF and V gt -INF"), [4]);
  });

  it("are written as strings on V4 and V2", async () => {
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
    const v2 = await get(`${s.v2}/Ms?$orderby=ID`, {
      accept: "application/json",
    });
    assert.deepEqual(
      v2.body.d.results.map((m: M) => m.V),
      ["INF", "-INF", "NaN", 1.5],
    );
  });

  it("as a property and its raw value", async () => {
    assert.equal((await get(`${s.v4}/Ms(1)/V`)).body.value, "INF");
    assert.equal((await get(`${s.v4}/Ms(3)/V/$value`)).body, "NaN");
  });

  it("survive a changeset that rolls back", async () => {
    const r = await batch(s.v4, [
      [
        { method: "PATCH", url: "Ms(4)", body: { V: 2.5 } },
        { method: "PATCH", url: "Ms(4)", body: { V: "not a number" } },
      ],
    ]);
    assert.ok(batchResponses(r.text).some((p) => p.status >= 400));
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
  });

  it("only these three: a key every object inherits is a 400", async () => {
    for (const V of ["toString", "constructor", "__proto__"]) {
      const r = await send("PATCH", `${s.v4}/Ms(4)`, { V });
      assert.equal(r.status, 400, V);
    }
    assert.deepEqual(await values(), ["INF", "-INF", "NaN", 1.5]);
  });
});

describe("NaN in what puts values in order", () => {
  let s: TestServer;
  before(async () => {
    s = await start(
      path.join(import.meta.dirname, "fixtures", "SpecialFloats"),
    );
  });
  after(() => s.close());

  // Replaces the rows with these values, in this order, and gives them to the test
  const rowsOf = async (values: (number | string | null)[]) => {
    for (const { ID } of (await get(`${s.v4}/Ms`)).body.value)
      await send("DELETE", `${s.v4}/Ms(${ID})`);
    for (const [ID, V] of values.entries())
      assert.equal((await send("POST", `${s.v4}/Ms`, { ID, V })).status, 201);
  };
  const read = async (query: string) =>
    (await get(`${s.v4}/Ms?${query}`)).body.value.map(
      (row: { V: unknown }) => row.V,
    );
  const aggregate = async (values: (number | string | null)[]) => {
    await rowsOf(values);
    const apply = encodeURIComponent(
      "aggregate(V with min as Low,V with max as High)",
    );
    const [{ Low, High }] = (await get(`${s.v4}/Ms?$apply=${apply}`)).body
      .value;
    return [Low, High];
  };

  const SCRAMBLED = [1.5, -1.5, null, 0, 1e300, "NaN", "INF", "-INF", 2.5, 0.5];

  it("$orderby: null, then the numbers, then NaN, wherever it stood", async () => {
    await rowsOf(SCRAMBLED);
    const up = [null, "-INF", -1.5, 0, 0.5, 1.5, 2.5, 1e300, "INF", "NaN"];
    assert.deepEqual(await read("$orderby=V"), up);
    assert.deepEqual(await read("$orderby=V desc"), [...up].reverse());
  });

  it("$orderby keeps the order of the rows that are equal, several NaNs too", async () => {
    await rowsOf(["NaN", 2, "NaN", 1]);
    const ids = (await get(`${s.v4}/Ms?$orderby=V`)).body.value.map(
      (row: { ID: number }) => row.ID,
    );
    assert.deepEqual(ids, [3, 1, 0, 2]);
  });

  it("min and max are the two ends of that order, whichever row comes first", async () => {
    assert.deepEqual(await aggregate(["NaN", 1, 2]), [1, "NaN"]);
    assert.deepEqual(await aggregate([1, "NaN", 2]), [1, "NaN"]);
    assert.deepEqual(await aggregate([1, 2, "NaN"]), [1, "NaN"]);
    assert.deepEqual(await aggregate(["NaN"]), ["NaN", "NaN"]);
  });

  it("a rank leaves NaN out, as it does null", async () => {
    await rowsOf(["NaN", 1, null, 3, 2]);
    const rank = (t: string) => read(`$apply=${encodeURIComponent(t)}`);
    assert.deepEqual(await rank("topcount(2,V)"), [3, 2]);
    assert.deepEqual(await rank("bottomcount(2,V)"), [1, 2]);
    assert.deepEqual(await rank("topsum(4,V)"), [3, 2]);
    assert.deepEqual(await rank("bottomsum(2,V)"), [1, 2]);
    assert.deepEqual(await rank("toppercent(50,V)"), [3]);
    assert.deepEqual(await rank("bottompercent(50,V)"), [1, 2]);
  });
});
