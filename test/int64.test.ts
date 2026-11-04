import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  start,
  send,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";

// Rows either side of 2^53, where a double can't tell two integers apart
const MODEL = path.join(import.meta.dirname, "fixtures", "BigInts");
const EVEN = "9007199254740992";
const ODD = "9007199254740993";
const NEGATIVE = "-9007199254740993";

// JSON.parse would round the very digits these tests are about, so they ask for strings
const STRINGS = { Accept: "application/json;IEEE754Compatible=true" };

describe("Edm.Int64 beyond 2^53 stays exact", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  // A fresh read of the IDs that match a query, in order
  const ids = async (query: string) => {
    const res = await fetch(`${s.v4}/Bigs?${query}&$select=ID`, {
      headers: STRINGS,
    });
    const body = (await res.json()) as { value: { ID: string }[] };
    assert.equal(res.status, 200, query);
    return body.value.map((r) => r.ID);
  };
  const v2ids = async (query: string) => {
    const res = await fetch(`${s.v2}/Bigs?${query}&$select=ID`);
    const text = await res.text();
    assert.equal(res.status, 200, query);
    return [...text.matchAll(/"ID":"(-?\d+)"/g)].map((m) => m[1]);
  };

  it("a V4 key finds its own row, not its neighbour", async () => {
    const res = await fetch(`${s.v4}/Bigs(${ODD})`, { headers: STRINGS });
    assert.equal(((await res.json()) as { Name: string }).Name, "odd");
  });

  it("a V2 key, with or without its L", async () => {
    for (const key of [`${ODD}L`, ODD]) {
      const res = await fetch(`${s.v2}/Bigs(${key})`);
      assert.match(await res.text(), /"Name":"odd"/, key);
    }
  });

  it("$filter on V4: eq, ne, gt, lt, on a key and on a property", async () => {
    assert.deepEqual(await ids(`$filter=I64 eq ${ODD}`), [ODD]);
    assert.deepEqual(await ids(`$filter=ID eq ${ODD}`), [ODD]);
    assert.deepEqual(await ids(`$filter=${ODD} eq I64`), [ODD]);
    assert.deepEqual(await ids(`$filter=I64 eq ${NEGATIVE}`), [NEGATIVE]);
    assert.deepEqual(await ids(`$filter=I64 gt ${EVEN}`), [ODD]);
    assert.deepEqual(await ids(`$filter=I64 lt ${ODD} and I64 gt 0`), [EVEN]);
    assert.deepEqual(await ids(`$filter=I64 ne ${ODD} and I64 gt 0`), [EVEN]);
  });

  it("$filter on V2: with L, and without", async () => {
    assert.deepEqual(await v2ids(`$filter=I64 eq ${ODD}L`), [ODD]);
    assert.deepEqual(await v2ids(`$filter=I64 eq ${ODD}`), [ODD]);
    assert.deepEqual(await v2ids(`$filter=I64 gt ${EVEN}L`), [ODD]);
  });

  it("a fraction still compares with an integer", async () => {
    assert.deepEqual(
      await ids("$filter=I64 gt 0.5 and I64 lt 9007199254740993"),
      [EVEN],
    );
  });

  it("$orderby sorts by every digit", async () => {
    assert.deepEqual(await ids("$orderby=I64 desc"), [ODD, EVEN, NEGATIVE]);
    assert.deepEqual(await ids("$orderby=I64 asc"), [NEGATIVE, EVEN, ODD]);
  });

  it("$apply min and max read every digit", async () => {
    const apply = encodeURIComponent(
      "aggregate(I64 with max as M,I64 with min as L)",
    );
    const res = await fetch(`${s.v4}/Bigs?$apply=${apply}`, {
      headers: STRINGS,
    });
    const { value } = (await res.json()) as { value: Record<string, string>[] };
    assert.equal(value[0].M, ODD);
    assert.equal(value[0].L, NEGATIVE);
  });

  it("a number in a body keeps its digits, directly and in a $batch", async () => {
    const post = await fetch(`${s.v4}/Bigs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...STRINGS },
      body: `{"ID":9007199254740995,"Dec":12345678901234567890.12}`,
    });
    assert.equal(post.status, 201);
    const row = (await post.json()) as { ID: string; Dec: string };
    assert.equal(row.ID, "9007199254740995");
    assert.equal(row.Dec, "12345678901234567890.12");

    const res = await fetch(`${s.v4}/$batch`, {
      method: "POST",
      headers: { "content-type": "multipart/mixed; boundary=b" },
      body: `--b\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nPOST Bigs HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"ID":9007199254740997}\r\n--b--\r\n`,
    });
    assert.equal(batchResponses(await res.text())[0].status, 201);
    assert.deepEqual(await ids("$filter=ID eq 9007199254740997"), [
      "9007199254740997",
    ]);
  });

  it("a short number in a body is still a number", async () => {
    const res = await send("POST", `${s.v4}/Bigs`, { ID: 7, Name: 1.5 });
    assert.equal(res.status, 400);
  });

  // Last: they change the rows the others read
  it("PATCH and DELETE change their own row", async () => {
    const patched = await send("PATCH", `${s.v4}/Bigs(${ODD})`, { Name: "p" });
    assert.equal(patched.status, 204);
    const names = async () => {
      const res = await fetch(
        `${s.v4}/Bigs?$filter=I64 gt 0 and I64 lt 9007199254740994`,
        {
          headers: STRINGS,
        },
      );
      const { value } = (await res.json()) as {
        value: { ID: string; Name: string }[];
      };
      return Object.fromEntries(value.map((r) => [r.ID, r.Name]));
    };
    assert.deepEqual(await names(), { [EVEN]: "even", [ODD]: "p" });

    const deleted = await send("DELETE", `${s.v4}/Bigs(${ODD})`);
    assert.equal(deleted.status, 204);
    assert.deepEqual(await names(), { [EVEN]: "even" });
  });

  it("in a $batch too", async () => {
    const res = await batch(s.v4, [{ method: "GET", url: `Bigs(${EVEN})` }]);
    assert.equal(batchResponses(res.text)[0].status, 200);
    assert.match(res.text, /"Name":"even"/);
  });
});
