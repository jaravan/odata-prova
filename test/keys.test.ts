import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send, type TestServer } from "./helpers.ts";
import { parseSegments } from "../lib/resource-path.ts";
import { HttpError } from "../lib/query.ts";

// String keys with characters a URL reserves, as SAP document numbers have them (SO/2025/1)
const MODEL = path.join(import.meta.dirname, "fixtures", "OddKeys");
const VALUE_KEYS = path.join(import.meta.dirname, "fixtures", "ValueKeys");
const VALUE_KEYS_V2 = path.join(import.meta.dirname, "fixtures", "ValueKeysV2");
const GUID_JOINS = path.join(import.meta.dirname, "fixtures", "GuidJoins");
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

describe("parseSegments", () => {
  it("reads a key's quotes: doubled ones, and in several values", () => {
    assert.deepEqual(parseSegments("Set('it''s')/Nav(A='x',B='y''')"), [
      { name: "Set", keyText: "'it''s'" },
      { name: "Nav", keyText: "A='x',B='y'''" },
    ]);
  });

  it("a parenthesis in a key's string is the string's", () => {
    assert.deepEqual(parseSegments("Set('a)b(')"), [
      { name: "Set", keyText: "'a)b('" },
    ]);
  });

  // Two ways of reading each pair of quotes made the time double with every pair, while the
  // one thread that answers every request waited for it
  it("a long run of quotes is a quick 400, however it ends", () => {
    for (const end of ["x", "", "'x", ")x"]) {
      const started = performance.now();
      assert.throws(
        () => parseSegments(`Alls('${"'".repeat(61)}${end}`),
        (e: unknown) => e instanceof HttpError && e.status === 400,
      );
      assert.ok(performance.now() - started < 500, JSON.stringify(end));
    }
  });
});

// A key's text isn't its value: a client writes 1.5 for 1.50, and either case of a GUID
describe("keys that compare by value", () => {
  let s: TestServer;
  before(async () => (s = await start(VALUE_KEYS)));
  after(() => s.close());

  it("Edm.Decimal: trailing zeros don't matter", async () => {
    assert.equal(
      (await send("POST", `${s.v4}/Decs`, { ID: "1.50" })).status,
      201,
    );
    assert.equal((await get(`${s.v4}/Decs(1.5)`)).status, 200);
    assert.equal((await get(`${s.v4}/Decs(1.50)`)).status, 200);
    assert.equal((await get(`${s.v4}/Decs(1.500)`)).status, 200);
    assert.equal((await get(`${s.v2}/Decs(1.5M)`)).status, 200);
    assert.equal((await get(`${s.v4}/Decs(1.51)`)).status, 404);
  });

  it("Edm.Decimal: the value keeps the digits it was written with", async () => {
    const read = await fetch(`${s.v4}/Decs(1.5)`);
    assert.match(await read.text(), /"ID":1\.50\b/);
  });

  it("Edm.Decimal: 1.5 is a duplicate of 1.50, 100 isn't of 1", async () => {
    assert.equal((await send("POST", `${s.v4}/Decs`, { ID: 1.5 })).status, 409);
    assert.equal((await send("POST", `${s.v4}/Decs`, { ID: "1" })).status, 201);
    assert.equal(
      (await send("POST", `${s.v4}/Decs`, { ID: "100" })).status,
      201,
    );
    assert.equal(
      (await send("POST", `${s.v4}/Decs`, { ID: "1.0" })).status,
      409,
    );
    assert.equal(
      (await send("POST", `${s.v4}/Decs`, { ID: "0.0" })).status,
      201,
    );
    assert.equal((await send("POST", `${s.v4}/Decs`, { ID: "0" })).status, 409);
  });

  const UPPER = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  const LOWER = UPPER.toLowerCase();

  it("Edm.Guid: either case finds it, and a case isn't a new key", async () => {
    const created = await send("POST", `${s.v4}/Ids`, {
      ID: UPPER,
      Other: UPPER,
    });
    assert.equal(created.status, 201);
    assert.equal(
      (await send("POST", `${s.v4}/Ids`, { ID: LOWER })).status,
      409,
    );
    assert.equal((await get(`${s.v4}/Ids(${LOWER})`)).status, 200);
    assert.equal((await get(`${s.v4}/Ids(${UPPER})`)).status, 200);
    assert.equal((await get(`${s.v2}/Ids(guid'${LOWER}')`)).status, 200);
  });

  it("Edm.Guid: $filter, on a key and a property", async () => {
    for (const filter of [
      `ID eq ${LOWER}`,
      `ID eq ${UPPER}`,
      `Other eq ${LOWER}`,
      `Other in (${LOWER})`,
    ]) {
      const res = await get(`${s.v4}/Ids?$filter=${filter}`);
      assert.equal(res.status, 200, filter);
      assert.equal(res.body.value.length, 1, filter);
    }
    const none = await get(`${s.v4}/Ids?$filter=ID ne ${LOWER}`);
    assert.equal(none.body.value.length, 0);
  });

  it("a key copied from a response finds the entity, though Precision cut its fraction", async () => {
    const created = await send("POST", `${s.v4}/Stamps`, {
      ID: "2025-01-01T10:00:00.123Z",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.ID, "2025-01-01T10:00:00Z");
    const read = await get(`${s.v4}/Stamps(${created.body.ID})`);
    assert.equal(read.status, 200);
    assert.equal(read.body.ID, "2025-01-01T10:00:00Z");
    const exact = await get(`${s.v4}/Stamps(2025-01-01T10:00:00.123Z)`);
    assert.equal(exact.status, 200);
    const dup = await send("POST", `${s.v4}/Stamps`, {
      ID: "2025-01-01T10:00:00Z",
    });
    assert.equal(dup.status, 409);
  });

  it("$filter finds a time by what a response shows, on V4", async () => {
    const shown = "2025-02-02T10:00:00Z";
    await send("POST", `${s.v4}/Stamps`, { ID: "2025-02-02T10:00:00.5Z" });
    const eq = await get(`${s.v4}/Stamps?$filter=ID eq ${shown}`);
    assert.deepEqual(
      eq.body.value.map((r: { ID: string }) => r.ID),
      [shown],
    );
    const gt = await get(`${s.v4}/Stamps?$filter=ID gt ${shown}`);
    assert.equal(gt.body.value.length, 0);
    const fine = await send("POST", `${s.v4}/Fines`, {
      ID: "2025-02-02T10:00:00.5Z",
    });
    assert.equal(fine.status, 201);
    const exact = await get(
      `${s.v4}/Fines?$filter=ID eq 2025-02-02T10:00:00.500Z`,
    );
    assert.equal(exact.body.value.length, 1);
    const other = await get(`${s.v4}/Fines?$filter=ID eq 2025-02-02T10:00:00Z`);
    assert.equal(other.body.value.length, 0);
  });

  it("a Precision that keeps the fraction keeps entities apart", async () => {
    for (const ID of ["2025-01-01T10:00:00.123Z", "2025-01-01T10:00:00.124Z"])
      assert.equal((await send("POST", `${s.v4}/Fines`, { ID })).status, 201);
    const read = await get(`${s.v4}/Fines(2025-01-01T10:00:00.124Z)`);
    assert.equal(read.body.ID, "2025-01-01T10:00:00.124Z");
    const offset = await get(`${s.v4}/Fines(2025-01-01T12:00:00.124%2B02:00)`);
    assert.equal(offset.status, 200);
  });
});

// V2 writes a time to the millisecond, so a V2 document's time keys are that exact on V4 too:
// a key read from either protocol finds the entity
describe("a time key of a V2 document", () => {
  let s: TestServer;
  before(async () => (s = await start(VALUE_KEYS_V2)));
  after(() => s.close());

  it("keeps entities a millisecond apart, and each key reads back on V4", async () => {
    for (const ID of ["2025-01-01T10:00:00.123", "2025-01-01T10:00:00.124"])
      assert.equal((await send("POST", `${s.v2}/Stamps`, { ID })).status, 201);
    const { value } = (await get(`${s.v4}/Stamps`)).body;
    assert.deepEqual(
      value.map((r: { ID: string }) => r.ID),
      ["2025-01-01T10:00:00.123Z", "2025-01-01T10:00:00.124Z"],
    );
    for (const { ID } of value) {
      const read = await get(`${s.v4}/Stamps(${ID})`);
      assert.equal(read.status, 200, ID);
      assert.equal(read.body.ID, ID);
    }
  });

  it("the generated V4 metadata gives the key Precision 3, and no other property", async () => {
    const { body } = await get(`${s.v4}/$metadata`);
    const stamp = body.slice(body.indexOf('Name="Stamp"'));
    assert.match(stamp, /Name="ID"[^>]*Precision="3"/);
    assert.doesNotMatch(
      stamp.split("</EntityType>")[0],
      /Name="At"[^>]*Precision/,
    );
  });

  it("a key that declares its own Precision keeps it", async () => {
    const { body } = await get(`${s.v4}/$metadata`);
    assert.match(
      body.slice(body.indexOf('Name="Exact"')),
      /Name="ID"[^>]*Precision="7"/,
    );
  });

  it("V2 reads it by its datetime literal", async () => {
    const read = await get(`${s.v2}/Stamps(datetime'2025-01-01T10:00:00.123')`);
    assert.equal(read.status, 200);
  });
});

// The two sides of a join may write a GUID in different cases: it's one value
describe("a GUID foreign key, in another case than its parent's key", () => {
  let s: TestServer;
  const UPPER = "AAAAAAAA-0000-4000-8000-000000000001";
  const LOWER = UPPER.toLowerCase();
  before(async () => (s = await start(GUID_JOINS)));
  after(() => s.close());

  it("the parent's collection holds both", async () => {
    const res = await get(`${s.v4}/Parents(${LOWER})/Kids/$count`);
    assert.equal(res.body, "2");
  });

  it("$expand, both ways", async () => {
    const { body } = await get(`${s.v4}/Parents?$expand=Kids`);
    assert.equal(body.value[0].Kids.length, 2);
    const kids = await get(`${s.v4}/Kids?$expand=Parent`);
    for (const kid of kids.body.value) assert.equal(kid.Parent.Name, "upper");
  });

  it("a child's parent, and $filter through it", async () => {
    assert.equal((await get(`${s.v4}/Kids(1)/Parent`)).body.Name, "upper");
    const filtered = await get(`${s.v4}/Kids?$filter=Parent/Name eq 'upper'`);
    assert.equal(filtered.body.value.length, 2);
    const any = await get(`${s.v4}/Parents?$filter=Kids/any(k:k/ID eq 1)`);
    assert.equal(any.body.value.length, 1);
  });

  it("the stored value keeps its case", async () => {
    assert.equal((await get(`${s.v4}/Parents(${LOWER})`)).body.ID, UPPER);
    assert.equal((await get(`${s.v4}/Kids(1)`)).body.ParentID, LOWER);
  });

  it("a key may hold a GUID in either case", async () => {
    await send("POST", `${s.v4}/Lines`, { ParentID: UPPER, No: 1 });
    const dup = await send("POST", `${s.v4}/Lines`, { ParentID: LOWER, No: 1 });
    assert.equal(dup.status, 409);
    const read = await get(`${s.v4}/Lines(ParentID=${LOWER},No=1)`);
    assert.equal(read.status, 200);
  });

  it("$filter on the foreign key finds it in either case", async () => {
    const { body } = await get(`${s.v4}/Kids?$filter=ParentID eq ${LOWER}`);
    assert.equal(body.value.length, 2);
  });
});
