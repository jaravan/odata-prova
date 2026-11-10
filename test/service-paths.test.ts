import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { serviceUrlPath } from "../lib/query.ts";
import { createApp } from "../lib/app.ts";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";

const MODEL = path.join(import.meta.dirname, "fixtures", "OddKeys");

// The service paths a folder's name gives (see SERVICE_NAME in server.ts), as a client writes
// them in a URL
const CASES = [
  ["a space", "/odata/My Srv", "/odata/My%20Srv"],
  ["non-ASCII", "/odata/Müller", "/odata/M%C3%BCller"],
  ["a # and a ?", "/odata/C#?", "/odata/C%23%3F"],
  ["a %", "/odata/50%", "/odata/50%25"],
  ["already encoded", "/odata/My%20Srv", "/odata/My%20Srv"],
] as const;

for (const [what, given, url] of CASES) {
  describe(`a service path with ${what}`, () => {
    let s: TestServer;
    const v4 = () => `${s.base}${url}/v4`;
    const v2 = () => `${s.base}${url}/v2`;
    before(
      async () =>
        (s = await start(MODEL, {
          v2Path: `${given}/v2`,
          v4Path: `${given}/v4`,
        })),
    );
    after(() => s.close());

    it("answers: the root, $metadata, an entity set, an entity", async () => {
      assert.equal((await get(`${v4()}/`)).status, 200);
      assert.equal((await get(`${v4()}/$metadata`)).status, 200);
      assert.equal((await get(`${v2()}/$metadata`)).status, 200);
      assert.equal((await get(`${v4()}/Docs`)).status, 200);
      assert.equal((await get(`${v4()}/Docs('%231')`)).body.No, "#1");
    });

    it("the URLs it writes lead back", async () => {
      const { body } = await get(`${v4()}/Docs('%231')`);
      const context = String(body["@odata.context"]).split("#")[0];
      assert.equal((await get(`${s.base}${context}`)).status, 200);
      const entity = (await get(`${v2()}/Docs('%231')`)).body.d;
      assert.equal(
        (await get(`${s.base}${entity.__metadata.uri}`)).status,
        200,
      );
      const created = await send("POST", `${v4()}/Docs`, { No: "N" });
      assert.equal(created.status, 201);
      const location = created.headers.get("location")!;
      assert.equal((await get(`${s.base}${location}`)).status, 200);
    });

    it("$batch: a relative URL and a full one", async () => {
      const res = await batch(v4(), [
        { method: "GET", url: "Docs('%231')" },
        { method: "GET", url: `${url}/v4/Docs('%231')` },
      ]);
      assert.equal(res.status, 200);
      assert.deepEqual(
        batchResponses(res.text).map((r) => r.status),
        [200, 200],
      );
    });

    it("a reference by its full URL", async () => {
      const res = await send("POST", `${v4()}/Lines`, {
        Pos: "1",
        "Doc@odata.bind": `${s.base}${url}/v4/Docs('%231')`,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.No, "#1");
    });

    it("an error is the service's, not Express's HTML page", async () => {
      const res = await get(`${v4()}/Nope`);
      assert.equal(res.status, 404);
      assert.ok(res.body.error, String(res.body));
    });
  });
}

describe("serviceUrlPath, as the server prints a service's URL", () => {
  it("is one a client can use", () => {
    assert.equal(serviceUrlPath("/odata/v4/My Srv"), "/odata/v4/My%20Srv");
    assert.equal(serviceUrlPath("/odata/v4/Plain"), "/odata/v4/Plain");
  });
});

describe("a percent-encoded service path, in either case of its hex digits", () => {
  let s: TestServer;
  const v4 = () => `${s.base}/odata/M%c3%bcller/v4`;
  before(
    async () =>
      (s = await start(MODEL, {
        v2Path: "/odata/Müller/v2",
        v4Path: "/odata/Müller/v4",
      })),
  );
  after(() => s.close());

  it("answers", async () => {
    assert.equal((await get(`${v4()}/Docs`)).status, 200);
    assert.equal((await get(`${v4()}/$metadata`)).status, 200);
  });

  it("$batch", async () => {
    const res = await batch(v4(), [{ method: "GET", url: "Docs('%231')" }]);
    assert.equal(res.status, 200);
    assert.equal(batchResponses(res.text)[0].status, 200);
  });

  it("an error is the right service's", async () => {
    const res = await get(`${s.base}/odata/M%c3%bcller/v2/Nope`);
    assert.equal(res.status, 404);
    assert.ok(res.body.error.message.value, "V2's error format");
  });

  it("the rest of the path stays exact", async () => {
    const res = await get(`${s.base}/odata/M%C3%BCLLER/v4/Docs`);
    assert.equal(res.status, 404);
  });
});

describe("service paths that can't work stop the start", () => {
  const mistake = (v2Path: string, v4Path: string, message: RegExp) =>
    assert.throws(
      () => createApp({ modelDir: MODEL, v2Path, v4Path, log() {} }),
      message,
    );

  it("one without its leading /", () => {
    mistake("/v2", "foo", /starts with \/, got foo/);
  });

  it("the same path for V2 and V4", () => {
    mistake("/a", "/a", /same/);
    mistake("/a", "/a/", /same/);
  });

  it("one inside the other, either way round", () => {
    mistake("/a", "/a/b", /inside/);
    mistake("/a/b", "/a", /inside/);
  });

  it("a shared beginning is fine", () => {
    assert.ok(
      createApp({ modelDir: MODEL, v2Path: "/a", v4Path: "/ab", log() {} }),
    );
  });

  it("one turned off is fine", () => {
    assert.ok(
      createApp({ modelDir: MODEL, v2Path: "", v4Path: "/a", log() {} }),
    );
  });
});
