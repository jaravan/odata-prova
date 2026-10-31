import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send, type TestServer } from "./helpers.ts";

// String keys with characters a URL reserves, as SAP document numbers have them (SO/2025/1)
const MODEL = path.join(import.meta.dirname, "fixtures", "OddKeys");
const KEYS = ["SO/2025/1", "a,b", "a=b", "#1", "?q", "&a", "50%", "it's"];

// A key as a client writes it in a URL: quoted, a quote doubled, then percent-encoded
const keyed = (key: string) =>
  `('${encodeURIComponent(key.replace(/'/g, "''"))}')`;

describe("keys with characters a URL reserves", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  it("each one reads, on both protocols", async () => {
    for (const key of KEYS) {
      const v4 = await get(`${s.v4}/Docs${keyed(key)}`);
      assert.equal(v4.status, 200, key);
      assert.equal(v4.body.No, key);
      const v2 = await get(`${s.v2}/Docs${keyed(key)}`);
      assert.equal(v2.status, 200, key);
      assert.equal(v2.body.d.No, key);
    }
  });

  it("the URIs the server writes lead back to the entity: __metadata.uri, Location", async () => {
    for (const key of KEYS) {
      const v2 = await get(`${s.v2}/Docs${keyed(key)}`);
      const back = await get(`${s.base}${v2.body.d.__metadata.uri}`);
      assert.equal(back.status, 200, `${key}: ${v2.body.d.__metadata.uri}`);
      assert.equal(back.body.d.No, key);
    }
    const created = await send("POST", `${s.v4}/Docs`, { No: "N/1?&#%" });
    assert.equal(created.status, 201);
    const location = created.headers.get("location")!;
    const back = await get(`${s.base}${location}`);
    assert.equal(back.status, 200, location);
    assert.equal(back.body.No, "N/1?&#%");
  });

  it("a composite key, a navigation and a write", async () => {
    const line = await get(
      `${s.v4}/Lines(No='${encodeURIComponent("SO/2025/1")}',Pos='${encodeURIComponent("20,B")}')/Doc`,
    );
    assert.equal(line.status, 200);
    assert.equal(line.body.No, "SO/2025/1");
    const patch = await send("PATCH", `${s.v4}/Docs${keyed("a=b")}`, {
      Text: "changed",
    });
    assert.equal(patch.status, 204);
    const lines = await get(`${s.v4}/Docs${keyed("SO/2025/1")}/Lines`);
    assert.equal(lines.body.value.length, 2);
  });

  it("an @odata.bind with such a key", async () => {
    const r = await send("POST", `${s.v4}/Lines`, {
      Pos: "30",
      "Doc@odata.bind": `Docs${keyed("SO/2025/1")}`,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.No, "SO/2025/1");
  });
});

describe("a function's parameters in the path", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  it("are decoded as keys are", async () => {
    const r = await get(
      `${s.v4}/FindDoc(no='${encodeURIComponent("SO/2025/1")}')`,
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it("a missing one that can't be null -> 400; one that can may be left out", async () => {
    const r = await get(`${s.v4}/FindDoc()`);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /no/);
    assert.equal((await get(`${s.v4}/FindDoc(no='x')`)).status !== 400, true);
  });

  it("one the function doesn't have -> 400 InvalidParameter", async () => {
    const r = await get(`${s.v4}/FindDoc(no='x',nope=1)`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "InvalidParameter");
  });
});
