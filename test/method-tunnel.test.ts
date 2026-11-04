import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send, type TestServer } from "./helpers.ts";

// UI5's V2 model, with useBatch off, sends a MERGE as a POST with X-HTTP-Method: MERGE
const MODEL = path.join(import.meta.dirname, "fixtures", "OddKeys");

describe("X-HTTP-Method on a POST", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  const doc = (root: string, no: string) => `${root}/Docs('${no}')`;

  it("MERGE changes the given properties, on V2 and V4", async () => {
    for (const root of [s.v2, s.v4]) {
      await send("POST", `${root}/Docs`, { No: "m", Text: "before" });
      const res = await send(
        "POST",
        doc(root, "m"),
        { Text: "merged" },
        { "X-HTTP-Method": "MERGE" },
      );
      assert.equal(res.status, 204);
      const read = await get(doc(root, "m"));
      assert.equal(read.body.d?.Text ?? read.body.Text, "merged");
      await send("DELETE", doc(root, "m"));
    }
  });

  it("the header's case doesn't matter, nor the value's", async () => {
    await send("POST", `${s.v2}/Docs`, { No: "c", Text: "before" });
    const res = await send(
      "POST",
      doc(s.v2, "c"),
      { Text: "after" },
      { "x-http-method": "merge" },
    );
    assert.equal(res.status, 204);
  });

  it("PATCH, PUT and DELETE too", async () => {
    await send("POST", `${s.v2}/Docs`, { No: "t", Text: "before" });
    const tunnel = (method: string, body?: unknown) =>
      send("POST", doc(s.v2, "t"), body, { "X-HTTP-Method": method });
    assert.equal((await tunnel("PATCH", { Text: "patched" })).status, 204);
    assert.equal((await tunnel("PUT", { Text: "put" })).status, 204);
    assert.equal((await tunnel("DELETE")).status, 204);
    assert.equal((await get(doc(s.v2, "t"))).status, 404);
  });

  it("any other value is no tunnel: GET can't be sent as a POST", async () => {
    const res = await send(
      "POST",
      doc(s.v2, "%231"),
      {},
      {
        "X-HTTP-Method": "GET",
      },
    );
    assert.equal(res.status, 405);
  });

  it("only a POST tunnels", async () => {
    const res = await fetch(doc(s.v2, "%231"), {
      headers: { "X-HTTP-Method": "DELETE" },
    });
    assert.equal(res.status, 200);
    assert.equal((await get(doc(s.v2, "%231"))).status, 200);
  });

  it("without the header, a POST on an entity is still a 405", async () => {
    const res = await send("POST", doc(s.v2, "%231"), {});
    assert.equal(res.status, 405);
  });
});
