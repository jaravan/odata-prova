import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqlitePersistence } from "../lib/sqlite.ts";
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

describe("INF, -INF and NaN as keys, saved and restarted", () => {
  const MODEL = path.join(import.meta.dirname, "fixtures", "DoubleKeys");
  let dir: string;
  let s: TestServer | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "double-keys-"));
  });
  afterEach(async () => {
    await s?.close();
    s = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const restart = async () => {
    await s?.close();
    s = await start(MODEL, {
      persistence: new SqlitePersistence(path.join(dir, "state.db")),
    });
    return s;
  };
  const keys = async () => {
    const { body } = await get(`${s!.v4}/Points?$orderby=K`);
    return body.value.map((p: { K: unknown; Note: unknown }) => [p.K, p.Note]);
  };
  const create = async (...values: unknown[]) => {
    for (const K of values)
      assert.equal(
        (await send("POST", `${s!.v4}/Points`, { K, Note: String(K) })).status,
        201,
      );
  };

  it("deleting one keeps the others", async () => {
    await restart();
    await create("INF", "-INF", "NaN", 1.5);
    assert.equal((await send("DELETE", `${s!.v4}/Points(-INF)`)).status, 204);
    const before = await keys();
    await restart();
    assert.deepEqual(await keys(), before);
    assert.equal(before.length, 3);
  });

  it("each is saved as a row of its own", async () => {
    await restart();
    await create("INF", "-INF", "NaN");
    await restart();
    assert.deepEqual(await keys(), [
      ["-INF", "-INF"],
      ["INF", "INF"],
      ["NaN", "NaN"],
    ]);
  });

  it("updating one changes that one, and no copy of it is left", async () => {
    await restart();
    await create("INF", "-INF");
    await send("PATCH", `${s!.v4}/Points(INF)`, { Note: "changed" });
    await restart();
    assert.deepEqual(await keys(), [
      ["-INF", "-INF"],
      ["INF", "changed"],
    ]);
  });

  it("a key with a finite value is as it was", async () => {
    await restart();
    await create(1.5, 0, -2);
    await send("DELETE", `${s!.v4}/Points(0)`);
    await restart();
    assert.equal((await keys()).length, 2);
  });
});

describe("a delta link and INF, -INF, NaN and null", () => {
  const VALUES = ["INF", "-INF", "NaN", null, 1.5];
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "DoubleKeys"));
    await send("POST", `${s.v4}/Points`, { K: 1 });
  });
  after(() => s.close());

  const changes = async (from: unknown, to: unknown) => {
    await send("PATCH", `${s.v4}/Points(1)`, { V: from });
    const tracked = await get(`${s.v4}/Points`, {
      prefer: "odata.track-changes",
    });
    await send("PATCH", `${s.v4}/Points(1)`, { V: to });
    const delta = await get(s.base + tracked.body["@odata.deltaLink"]);
    return delta.body.value as { V: unknown }[];
  };

  for (const from of VALUES)
    for (const to of VALUES) {
      if (from === to) {
        it(`${from} to itself is no change`, async () => {
          assert.deepEqual(await changes(from, to), []);
        });
        continue;
      }
      it(`${from} to ${to} is a change`, async () => {
        const rows = await changes(from, to);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].V, to);
      });
    }
});

describe("V2's INF, -INF and NaN in a $filter", () => {
  let s: TestServer;
  before(
    async () =>
      (s = await start(
        path.join(import.meta.dirname, "fixtures", "SpecialFloats"),
      )),
  );
  after(() => s.close());

  const values = async (filter: string) => {
    const r = await get(`${s.v2}/Ms?$filter=${encodeURIComponent(filter)}`);
    assert.equal(r.status, 200, filter);
    return r.body.d.results.map((m: M) => m.V);
  };

  for (const [filter, expected] of [
    ["V eq INF", ["INF"]],
    ["V eq -INF", ["-INF"]],
    ["V eq INFd", ["INF"]],
    ["V eq INFf", ["INF"]],
    ["V eq NaN", []],
    ["V ne NaN", ["INF", "-INF", "NaN", 1.5]],
    ["V gt 1.5d and V lt INF", []],
  ] as const)
    it(`${filter} reads the same as in V4`, async () => {
      assert.deepEqual(await values(filter), expected);
      const v4 = await get(
        `${s.v4}/Ms?$filter=${encodeURIComponent(filter.replace(/\b(INF|NaN)[df]\b/, "$1").replace("1.5d", "1.5"))}`,
      );
      assert.deepEqual(
        v4.body.value.map((m: M) => m.V),
        expected,
      );
    });

  it("a name that only starts with one is still a name", async () => {
    const r = await get(
      `${s.v2}/Ms?$filter=${encodeURIComponent("INFO eq 1")}`,
    );
    assert.equal(r.status, 400);
    assert.match(r.body.error.message.value, /INFO/);
  });
});
