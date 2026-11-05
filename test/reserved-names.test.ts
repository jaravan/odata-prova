// A set, a property, a navigation or a parameter can be named after what every JavaScript
// object already has: constructor, toString, valueOf, hasOwnProperty. Each is an ordinary name.

import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqlitePersistence } from "../lib/sqlite.ts";
import {
  batch,
  batchResponses,
  get,
  send,
  start,
  type TestServer,
} from "./helpers.ts";

const RESERVED = path.join(import.meta.dirname, "fixtures", "ReservedNames");

// One parent (1000) with one kid (900)
async function family(s: TestServer) {
  assert.equal(
    (await send("POST", `${s.v4}/toString`, { ID: 1000 })).status,
    201,
  );
  const { status } = await send("POST", `${s.v4}/constructor`, {
    ID: 900,
    constructor: "x",
    valueOf: 3,
    ParentID: 1000,
  });
  assert.equal(status, 201);
}

describe("names every JavaScript object has", () => {
  let s: TestServer;
  before(async () => {
    s = await start(RESERVED);
    await family(s);
  });
  after(() => s.close());

  for (const url of [
    "constructor",
    "constructor(900)",
    "constructor(900)/constructor",
    "constructor(900)/constructor/$value",
    "constructor(900)/hasOwnProperty",
    "constructor(900)/hasOwnProperty/$ref",
    "toString(1000)/toString",
    "toString(1000)/toString/$count",
    "toString(1000)/toString/$ref",
    "constructor?$expand=hasOwnProperty",
    "toString?$expand=toString($select=constructor)",
    "constructor?$orderby=constructor desc,valueOf&$select=constructor,valueOf",
    "constructor?$filter=hasOwnProperty/ID eq 1000 and constructor eq 'x'",
    "toString?$filter=toString/any(k:k/constructor eq 'x')",
    "constructor?$apply=groupby((hasOwnProperty/ID,constructor),aggregate(valueOf with sum as T))",
    "constructor?$compute=valueOf add 1 as K",
    "Find(valueOf=1)",
    "$metadata",
  ]) {
    it(`GET ${url}`, async () => {
      assert.equal((await get(encodeURI(`${s.v4}/${url}`))).status, 200);
    });
  }

  for (const url of [
    "constructor",
    "constructor(900)",
    "constructor(900)/hasOwnProperty",
    "constructor?$expand=hasOwnProperty&$inlinecount=allpages",
    "$metadata",
  ]) {
    it(`V2: GET ${url}`, async () => {
      assert.equal((await get(`${s.v2}/${url}`)).status, 200);
    });
  }

  it("a kid reads its parent, and a parent its kid", async () => {
    const kid = await get(`${s.v4}/constructor(900)?$expand=hasOwnProperty`);
    assert.equal(kid.body.hasOwnProperty.ID, 1000);
    const parent = await get(`${s.v4}/toString(1000)/toString`);
    assert.deepEqual(
      parent.body.value.map((k: { ID: number }) => k.ID),
      [900],
    );
  });

  it("a property not sent is null, not what the object inherits", async () => {
    await send("POST", `${s.v4}/constructor`, { ID: 950 });
    const { body } = await get(`${s.v4}/constructor(950)`);
    assert.equal(body.constructor, null);
    assert.equal(body.valueOf, null);
  });

  it("a member of a complex value not sent is null", async () => {
    await send("POST", `${s.v4}/constructor`, {
      ID: 951,
      Where: { City: "Oslo" },
    });
    const { body } = await get(`${s.v4}/constructor(951)`);
    assert.deepEqual(body.Where, { constructor: null, City: "Oslo" });
    const v2 = await get(`${s.v2}/constructor(951)`);
    assert.equal(v2.body.d.Where.constructor, null);
  });

  it("a parameter left out is one that's needed", async () => {
    assert.equal((await get(`${s.v4}/Find()`)).status, 400);
  });

  it("PATCH, PUT and V2's MERGE change it, and DELETE removes it", async () => {
    const url = `${s.v4}/constructor(900)`;
    await send("PATCH", url, { constructor: "patched" });
    assert.equal((await get(url)).body.constructor, "patched");
    await send("PUT", url, { constructor: "put", ParentID: 1000 });
    assert.equal((await get(url)).body.constructor, "put");
    await send("MERGE", `${s.v2}/constructor(900)`, { constructor: "v2" });
    assert.equal((await get(url)).body.constructor, "v2");
    await send("POST", `${s.v4}/constructor`, { ID: 952 });
    assert.equal(
      (await send("DELETE", `${s.v4}/constructor(952)`)).status,
      204,
    );
    assert.equal((await get(`${s.v4}/constructor(952)`)).status, 404);
  });

  it("an update to a navigation's link changes what it reads", async () => {
    await send("POST", `${s.v4}/toString`, { ID: 1001 });
    const url = `${s.v4}/constructor(900)/hasOwnProperty`;
    const { status } = await send("PUT", `${url}/$ref`, {
      "@odata.id": "toString(1001)",
    });
    assert.equal(status, 204);
    assert.equal((await get(url)).body.ID, 1001);
  });

  it("a deep insert goes through the navigation, and a bind links one", async () => {
    const { status } = await send("POST", `${s.v4}/toString`, {
      ID: 1002,
      toString: [{ ID: 960, constructor: "deep" }],
    });
    assert.equal(status, 201);
    assert.equal((await get(`${s.v4}/constructor(960)`)).body.ParentID, 1002);
    const bound = await send("POST", `${s.v4}/constructor`, {
      ID: 961,
      "hasOwnProperty@odata.bind": "toString(1002)",
    });
    assert.equal(bound.status, 201);
    assert.equal((await get(`${s.v4}/constructor(961)`)).body.ParentID, 1002);
  });

  it("a changeset", async () => {
    const res = await batch(s.v4, [
      [
        { method: "POST", url: "toString", body: { ID: 1003 }, contentId: "1" },
        { method: "POST", url: "$1/toString", body: { ID: 970 } },
      ],
    ]);
    assert.deepEqual(
      batchResponses(res.text).map((r) => r.status),
      [201, 201],
    );
    assert.equal((await get(`${s.v4}/constructor(970)`)).body.ParentID, 1003);
  });

  it("a delta link reports a change", async () => {
    const r = await get(`${s.v4}/constructor`, {
      prefer: "odata.track-changes",
    });
    await send("POST", `${s.v4}/constructor`, { ID: 971 });
    await send("PATCH", `${s.v4}/constructor(971)`, { constructor: "tracked" });
    const delta = await get(s.base + r.body["@odata.deltaLink"]);
    assert.ok(
      delta.body.value.some(
        (row: { constructor: string }) => row.constructor === "tracked",
      ),
    );
  });
});

describe("names every JavaScript object has, generated and saved", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "reserved-"));
  });

  // Closed whatever the test does, or a failure would leave the process running
  const open: TestServer[] = [];
  const started = async () => {
    const s = await start(RESERVED, {
      mockRows: 3,
      persistence: new SqlitePersistence(path.join(dir, "state.db")),
    });
    open.push(s);
    return s;
  };
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("mock rows are generated, a kid pointing at a parent", async () => {
    const s = await started();
    const kids = (await get(`${s.v4}/constructor`)).body.value;
    const parents = (await get(`${s.v4}/toString`)).body.value;
    assert.equal(kids.length, 3);
    const ids = parents.map((p: { ID: number }) => p.ID);
    for (const kid of kids) assert.ok(ids.includes(kid.ParentID));
  });

  it("what was written is there after a restart", async () => {
    const first = await started();
    await send("POST", `${first.v4}/constructor`, { ID: 900 });
    await send("PATCH", `${first.v4}/constructor(900)`, {
      constructor: "kept",
    });
    await open.pop()!.close();
    const again = await started();
    const { body } = await get(`${again.v4}/constructor(900)`);
    assert.equal(body.constructor, "kept");
  });
});
