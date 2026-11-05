import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send, type TestServer } from "./helpers.ts";

const MODEL = path.join(import.meta.dirname, "fixtures", "KeyTypes");

describe("the URL the server gives an entity finds it", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  const cases: [string, unknown][] = [
    ["Durations", "P1D"],
    ["Durations", "PT1H"],
    ["Durations", "-PT1S"],
    ["Durations", "P1DT1H1M1.5S"],
    ["Binaries", "AAAA"],
    ["Binaries", "YWI="],
    ["Binaries", "YQ=="],
    ["Binaries", "+/+/"],
    ["Binaries", "_-_-"],
    ["Doubles", 1.5],
    ["Doubles", "INF"],
    ["Doubles", "-INF"],
    ["Doubles", "NaN"],
    ["Singles", "INF"],
    ["Singles", "-INF"],
    ["Singles", "NaN"],
    ["Stamps", "9999-12-31T23:59:59Z"],
    ["Stamps", "0000-01-01T00:00:00Z"],
  ];

  for (const [set, id] of cases)
    it(`${set} ${String(id)}: found and deleted by V4's URL and by V2's`, async () => {
      const created = await send("POST", `${s.v4}/${set}`, { Id: id });
      assert.equal(created.status, 201);
      const location = `${s.base}${created.headers.get("location")}`;
      const v4 = await get(location);
      assert.equal(v4.status, 200, JSON.stringify(v4.body));
      assert.deepEqual(v4.body.Id, created.body.Id);

      const [entity] = (await get(`${s.v2}/${set}`)).body.d.results;
      const uri = `${s.base}${entity.__metadata.uri}`;
      assert.equal((await get(uri)).status, 200, uri);

      assert.equal((await send("DELETE", uri)).status, 204);
      assert.equal((await get(`${s.v4}/${set}/$count`)).body, "0");

      const again = await send("POST", `${s.v4}/${set}`, { Id: id });
      const url = `${s.base}${again.headers.get("location")}`;
      assert.equal((await send("DELETE", url)).status, 204);
      assert.equal((await get(url)).status, 404);
    });

  it("a key of several parts", async () => {
    const created = await send("POST", `${s.v4}/Boths`, {
      Data: "YQ==",
      Took: "PT1H",
    });
    assert.equal(created.status, 201);
    const location = `${s.base}${created.headers.get("location")}`;
    assert.equal((await get(location)).status, 200);
    assert.equal((await send("DELETE", location)).status, 204);
  });

  it("a client writes these literals as the spec does", async () => {
    await send("POST", `${s.v4}/Durations`, { Id: "PT5S" });
    assert.equal((await get(`${s.v4}/Durations(duration'PT5S')`)).status, 200);
    await send("POST", `${s.v4}/Doubles`, { Id: "-INF" });
    assert.equal((await get(`${s.v4}/Doubles(-INF)`)).status, 200);
    assert.equal((await get(`${s.v2}/Doubles(-INF)`)).status, 200);
    assert.equal((await get(`${s.v2}/Doubles(-INFd)`)).status, 200);
  });
});

describe("a date and time past what ISO 8601's four digits of a year hold -> 400", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  for (const id of ["9999-12-31T23:59:59-14:00", "0000-01-01T00:00:00+14:00"])
    it(`${id}, which UTC puts in another year`, async () => {
      const r = await send("POST", `${s.v4}/Stamps`, { Id: id });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, "InvalidValue");
    });

  it("in V2's form too", async () => {
    const r = await send("POST", `${s.v2}/Stamps`, {
      Id: "/Date(253402300800000)/",
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "InvalidValue");
  });
});

// V2 writes binary literals in hex: binary'31' and X'31' are the byte 0x31
describe("V2's hex binary literals", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "KeyTypes"));
    for (const Id of ["MQ==", "AAAA", "+/+/", "YQ"])
      assert.equal(
        (await send("POST", `${s.v4}/Binaries`, { Id })).status,
        201,
      );
  });
  after(() => s.close());

  const found = async (url: string) =>
    (await get(`${s.v2}/${url}`)).body?.d?.Id;
  const filter = async (expression: string) =>
    (await get(`${s.v2}/Binaries?$filter=${encodeURIComponent(expression)}`))
      .body.d.results.length;

  for (const literal of ["binary'31'", "X'31'", "x'31'", "binary'MQ%3D%3D'"])
    it(`Binaries(${literal}) is the row`, async () => {
      assert.equal(await found(`Binaries(${literal})`), "MQ==");
    });

  it("in either case of the hex digits", async () => {
    assert.equal(await found("Binaries(X'FBFFBF')"), "+/+/");
    assert.equal(await found("Binaries(X'fbffbf')"), "+/+/");
  });

  it("in a $filter", async () => {
    assert.equal(await filter("Id eq X'31'"), 1);
    assert.equal(await filter("Id eq binary'31'"), 1);
    assert.equal(await filter("Id eq binary'MQ=='"), 1);
    assert.equal(await filter("Id eq X'32'"), 0);
  });

  it("base64 that looks like hex is hex, so AAAA is two bytes", async () => {
    assert.equal(await found("Binaries(binary'000000')"), "AAAA");
    assert.equal(await found("Binaries(binary'AAAA')"), undefined);
  });

  it("the server's own links are in hex, and lead to the row", async () => {
    const { results } = (await get(`${s.v2}/Binaries`)).body.d;
    for (const row of results) {
      assert.match(row.__metadata.uri, /Binaries\(binary'[0-9A-F]*'\)$/);
      const { body } = await get(`${s.base}${row.__metadata.uri}`);
      assert.equal(body.d.Id, row.Id);
    }
  });

  it("the same bytes are the same key however they're spelled", async () => {
    assert.equal(
      (await send("POST", `${s.v4}/Binaries`, { Id: "YQ==" })).status,
      409,
    );
  });

  it("V4 stays base64url", async () => {
    assert.equal((await get(`${s.v4}/Binaries(binary'MQ==')`)).status, 200);
  });
});
