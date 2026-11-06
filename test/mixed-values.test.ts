// Enums by their values, defaults, and what a request asks that used to pass unnoticed.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start, type TestServer } from "./helpers.ts";

const MODEL = path.join(import.meta.dirname, "fixtures", "Mixed");
const JSON_TYPE = { "content-type": "application/json" };

describe("enums", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    for (const row of [
      { ID: 1, Pm: "W,R", Col: "Red" },
      { ID: 2, Pm: "R,W", Col: "Blue" },
      { ID: 3, Pm: "R,R", Col: "Green" },
      { ID: 4, Pm: "3", Col: "4" },
    ])
      assert.equal(
        (await send("POST", `${s.v4}/Items`, { Name: "n", ...row })).status,
        201,
      );
  });
  after(() => s.close());

  const ids = async (filter: string) => {
    const { status, body } = await get(
      `${s.v4}/Items?$select=ID&$filter=${encodeURIComponent(filter)}`,
    );
    assert.equal(status, 200, filter);
    return body.value.map((r: { ID: number }) => r.ID);
  };

  it("a flags value is held one way, in the order of its members' values", async () => {
    const { body } = await get(`${s.v4}/Items?$select=Pm`);
    assert.deepEqual(
      body.value.map((r: { Pm: string }) => r.Pm),
      ["R,W", "R,W", "R", "R,W"],
    );
  });

  for (const literal of ["R,W", "W,R", "3"])
    it(`Pm eq F.Perm'${literal}' finds every spelling`, async () => {
      assert.deepEqual(await ids(`Pm eq F.Perm'${literal}'`), [1, 2, 4]);
    });

  it("groups and counts them as one", async () => {
    const groups = await get(`${s.v4}/Items?$apply=groupby((Pm))`);
    assert.equal(groups.body.value.length, 2);
    const count = await get(
      `${s.v4}/Items?$apply=${encodeURIComponent("aggregate(Pm with countdistinct as N)")}`,
    );
    assert.equal(count.body.value[0].N, 2);
  });

  for (const [filter, expected] of [
    ["Col gt F.Color'Green'", [2, 4]],
    ["Col lt F.Color'Green'", [1]],
    ["Col ge F.Color'Green'", [2, 3, 4]],
    ["Col eq 2", [3]],
    ["Col gt 1", [2, 3, 4]],
    ["Col eq 8", []],
    ["Pm has 1", [1, 2, 3, 4]],
    ["Pm has 2", [1, 2, 4]],
    ["Pm has F.Perm'W'", [1, 2, 4]],
    ["Pm has F.Perm'X'", []],
    ["Col in (F.Color'Red',2)", [1, 3]],
  ] as const)
    it(`${filter}`, async () => {
      assert.deepEqual(await ids(filter), expected);
    });

  it("sort by value", async () => {
    const { body } = await get(`${s.v4}/Items?$orderby=Col,ID&$select=ID`);
    assert.deepEqual(
      body.value.map((r: { ID: number }) => r.ID),
      [1, 3, 2, 4],
    );
  });

  it("min and max by value", async () => {
    const { body } = await get(
      `${s.v4}/Items?$apply=${encodeURIComponent("aggregate(Col with max as A,Col with min as B)")}`,
    );
    assert.equal(body.value[0].A, "Blue");
    assert.equal(body.value[0].B, "Red");
  });

  it("a value no member makes up is refused", async () => {
    const res = await send("POST", `${s.v4}/Items`, {
      ID: 9,
      Name: "n",
      Pm: "8",
    });
    assert.equal(res.status, 400);
  });
});

describe("DefaultValue", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
  });
  afterEach(() => s.close());

  it("fills what a create leaves out", async () => {
    const { status, body } = await send("POST", `${s.v4}/Items`, { ID: 1 });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.Name, "Open");
    assert.equal(body.Note, "hi");
  });

  it("not what it sets, even to null", async () => {
    const { body } = await send("POST", `${s.v4}/Items`, {
      ID: 1,
      Name: "mine",
      Note: null,
    });
    assert.equal(body.Name, "mine");
    assert.equal(body.Note, null);
    const required = await send("POST", `${s.v4}/Items`, { ID: 2, Name: null });
    assert.equal(required.status, 400);
  });

  it("a PUT resets to it", async () => {
    await send("POST", `${s.v4}/Items`, { ID: 1, Name: "mine", Note: "x" });
    const res = await send("PUT", `${s.v4}/Items(1)`, { Qty: 1 });
    assert.equal(res.status, 204);
    const { body } = await get(`${s.v4}/Items(1)`);
    assert.equal(body.Name, "Open");
    assert.equal(body.Note, "hi");
  });

  it("the generated V2 $metadata has it", async () => {
    const xml = await (await fetch(`${s.v2}/$metadata`)).text();
    assert.match(xml, /Name="Name"[^>]*DefaultValue="Open"/);
  });
});

describe("a write with no body", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Name: "kept", Note: "kept" });
  });
  after(() => s.close());

  for (const method of ["PUT", "PATCH"])
    it(`${method} is a 400, and wipes nothing`, async () => {
      const res = await fetch(`${s.v4}/Items(1)`, {
        method,
        headers: JSON_TYPE,
      });
      assert.equal(res.status, 400);
      assert.equal((await get(`${s.v4}/Items(1)`)).body.Note, "kept");
    });

  it("{} is a body: it changes nothing", async () => {
    assert.equal((await send("PATCH", `${s.v4}/Items(1)`, {})).status, 204);
  });
});

describe("paths in an expression", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Grps`, { ID: 5 });
    await send("POST", `${s.v4}/Items`, {
      ID: 1,
      Tags: ["a", "b"],
      Kids: [{ ID: 7 }, { ID: 8 }],
    });
    await send("POST", `${s.v4}/Items`, { ID: 2 });
  });
  after(() => s.close());

  const ids = async (query: string) => {
    const { status, body } = await get(
      `${s.v4}/Items?$select=ID&${encodeURI(query)}`,
    );
    assert.equal(status, 200, JSON.stringify(body));
    return body.value.map((r: { ID: number }) => r.ID);
  };

  for (const [query, expected] of [
    ["$filter=Kids/$count gt 0", [1]],
    ["$filter=Kids/$count eq 0", [2]],
    ["$filter=Kids/$count gt 1 and Tags/$count eq 2", [1]],
    ["$filter=Tags/$count gt 1", [1]],
    ["$orderby=Kids/$count desc", [1, 2]],
    ["$orderby=Kids/$count", [2, 1]],
    ["$filter=Group eq null", [1, 2]],
    ["$filter=Group ne null", []],
  ] as const)
    it(`${query}`, async () => {
      assert.deepEqual(await ids(query), expected);
    });

  it("$count of what isn't a collection is a 400", async () => {
    const { status } = await get(
      `${s.v4}/Items?$filter=${encodeURIComponent("Qty/$count gt 0")}`,
    );
    assert.equal(status, 400);
  });
});
