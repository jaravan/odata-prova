import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseMetadata } from "../lib/metadata.ts";
import { emitV2 } from "../lib/emit-v2.ts";
import { emitV4 } from "../lib/emit-v4.ts";
import { renewETag } from "../lib/etag.ts";
import type { Row } from "../lib/model.ts";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const V4_MODEL = path.join(FIXTURES, "ETagSrv");
const V2_MODEL = path.join(FIXTURES, "ETagSrvV2");

describe("ETags (Core.OptimisticConcurrency, V4 document, strict)", () => {
  let s: TestServer;
  before(async () => (s = await start(V4_MODEL, { etags: "strict" })));
  after(() => s.close());

  const book = (id: number) => `${s.v4}/Books(${id})`;
  const etagOf = async (id: number) =>
    (await get(book(id))).headers.get("etag")!;

  it("an entity carries its ETag, in the header and the payload", async () => {
    const r = await get(book(1));
    assert.equal(r.status, 200);
    const etag = r.headers.get("etag");
    assert.equal(etag, 'W/"2026-01-01T10:00:00.000Z"');
    assert.equal(r.body["@odata.etag"], etag);
    const all = await get(`${s.v4}/Books`);
    assert.equal(all.body.value[0]["@odata.etag"], etag);
  });

  it("an entity set without Core.OptimisticConcurrency has none, and needs no If-Match", async () => {
    const r = await get(`${s.v4}/Notes(1)`);
    assert.equal(r.headers.get("etag"), null);
    assert.equal(r.body["@odata.etag"], undefined);
    const patch = await send("PATCH", `${s.v4}/Notes(1)`, { text: "x" });
    assert.equal(patch.status, 204);
  });

  it("an update or delete without If-Match -> 428, and nothing changes", async () => {
    const patch = await send("PATCH", book(2), { title: "Changed" });
    assert.equal(patch.status, 428);
    assert.equal(patch.body.error.code, "ETagRequired");
    assert.match(patch.body.error.message, /If-Match/);
    const del = await send("DELETE", book(2));
    assert.equal(del.status, 428);
    assert.equal((await get(book(2))).body.title, "Jane Eyre");
  });

  it("an update with the current ETag -> 204 with the new one, and the old one goes stale", async () => {
    const before = await etagOf(1);
    const r = await send(
      "PATCH",
      book(1),
      { title: "Wuthering Heights (2nd ed.)" },
      { "if-match": before },
    );
    assert.equal(r.status, 204);
    const after = r.headers.get("etag")!;
    assert.notEqual(after, before);
    assert.equal(await etagOf(1), after);
    // modifiedAt is the server's: it moved on
    assert.ok((await get(book(1))).body.modifiedAt > "2026-01-01T10:00:00");

    const stale = await send(
      "PATCH",
      book(1),
      { title: "Lost update" },
      { "if-match": before },
    );
    assert.equal(stale.status, 412);
    assert.equal(stale.body.error.code, "ETagMismatch");
    assert.equal(
      (await get(book(1))).body.title,
      "Wuthering Heights (2nd ed.)",
    );
  });

  it("If-Match: * or a list holding the current ETag matches; weak or not", async () => {
    let r = await send("PATCH", book(2), { status: "a" }, { "if-match": "*" });
    assert.equal(r.status, 204);
    const etag = await etagOf(2);
    r = await send(
      "PATCH",
      book(2),
      { status: "b" },
      { "if-match": `W/"stale", ${etag}` },
    );
    assert.equal(r.status, 204);
    r = await send(
      "PATCH",
      book(2),
      { status: "c" },
      { "if-match": (await etagOf(2)).replace(/^W\//, "") },
    );
    assert.equal(r.status, 204);
  });

  it("two quick updates still give two ETags", async () => {
    const first = await send(
      "PATCH",
      book(2),
      { status: "d" },
      { "if-match": "*" },
    );
    const second = await send(
      "PATCH",
      book(2),
      { status: "e" },
      { "if-match": "*" },
    );
    assert.notEqual(first.headers.get("etag"), second.headers.get("etag"));
  });

  it("an entity without a value for its ETag's property gets one on its first update", async () => {
    assert.equal(await etagOf(3), 'W/""');
    const r = await send(
      "PATCH",
      book(3),
      { status: "x" },
      { "if-match": 'W/""' },
    );
    assert.equal(r.status, 204);
    assert.notEqual(r.headers.get("etag"), 'W/""');
  });

  it("a new entity gets an ETag", async () => {
    const r = await send("POST", `${s.v4}/Books`, { ID: 10, title: "New" });
    assert.equal(r.status, 201);
    assert.match(r.headers.get("etag") ?? "", /^W\/"\d{4}-/);
    assert.equal(r.body["@odata.etag"], r.headers.get("etag"));
  });

  it("a delete with the current ETag -> 204", async () => {
    const r = await send("DELETE", book(10), undefined, {
      "if-match": await etagOf(10),
    });
    assert.equal(r.status, 204);
    assert.equal((await get(book(10))).status, 404);
  });

  it("an action checks If-Match when sent, and its rule gives the entity a new ETag", async () => {
    const url = `${book(2)}/ETagSrv.approve`;
    const stale = await send("POST", url, {}, { "if-match": 'W/"stale"' });
    assert.equal(stale.status, 412);
    const before = await etagOf(2);
    const r = await send("POST", url, {}); // no If-Match: the spec leaves actions open
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "approved");
    assert.notEqual(r.headers.get("etag"), before);
  });

  it("in a $batch changeset, a stale If-Match fails the changeset", async () => {
    const etag = await etagOf(1);
    const r = await batch(s.v4, [
      [
        {
          method: "PATCH",
          url: "Books(2)",
          body: { title: "In a changeset" },
          headers: { "If-Match": "*" },
        },
        {
          method: "PATCH",
          url: "Books(1)",
          body: { title: "Stale" },
          headers: { "If-Match": 'W/"stale"' },
        },
      ],
    ]);
    const [failed] = batchResponses(r.text);
    assert.equal(failed.status, 412);
    assert.notEqual((await get(book(2))).body.title, "In a changeset");
    assert.equal(await etagOf(1), etag);
  });
});

describe("ETags (ConcurrencyMode=Fixed, V2 document, strict)", () => {
  let s: TestServer;
  before(async () => (s = await start(V2_MODEL, { etags: "strict" })));
  after(() => s.close());

  const order = (v: string) => `${v}/OrderSet('4500000001')`;

  it("V2: in __metadata and the header, made of every Fixed property", async () => {
    const r = await get(order(s.v2));
    const etag = r.headers.get("etag");
    assert.equal(etag, 'W/"2026-01-01T10:00:00.000Z,1"');
    assert.equal(r.body.d.__metadata.etag, etag);
  });

  it("V2: a MERGE needs it, and counts the version up", async () => {
    const etag = (await get(order(s.v2))).headers.get("etag")!;
    const without = await send("MERGE", order(s.v2), { Note: "x" });
    assert.equal(without.status, 428);
    const r = await send(
      "MERGE",
      order(s.v2),
      { Note: "x" },
      { "if-match": etag },
    );
    assert.equal(r.status, 204);
    assert.equal((await get(order(s.v2))).body.d.Version, 2);
  });

  it("V4 serves the same ETag", async () => {
    const v2 = (await get(order(s.v2))).headers.get("etag");
    const v4 = await get(order(s.v4));
    assert.equal(v4.headers.get("etag"), v2);
    assert.equal(v4.body["@odata.etag"], v2);
  });
});

describe("ETags, lenient (the default)", () => {
  let s: TestServer;
  before(async () => (s = await start(V4_MODEL)));
  after(() => s.close());

  const book = (id: number) => `${s.v4}/Books(${id})`;

  it("an update or delete without If-Match goes through, and gives a new ETag", async () => {
    const before = (await get(book(1))).headers.get("etag");
    const patch = await send("PATCH", book(1), { title: "Changed" });
    assert.equal(patch.status, 204);
    assert.notEqual(patch.headers.get("etag"), before);
    assert.equal((await send("DELETE", book(2))).status, 204);
  });

  it("a stale If-Match is still a 412", async () => {
    const r = await send(
      "PATCH",
      book(1),
      { title: "Lost update" },
      { "if-match": 'W/"stale"' },
    );
    assert.equal(r.status, 412);
    assert.equal((await get(book(1))).body.title, "Changed");
  });
});

describe("ETags, off", () => {
  let s: TestServer;
  before(async () => (s = await start(V4_MODEL, { etags: "off" })));
  after(() => s.close());

  const book = (id: number) => `${s.v4}/Books(${id})`;

  it("If-Match is ignored, stale or missing", async () => {
    const stale = await send(
      "PATCH",
      book(1),
      { title: "Changed" },
      { "if-match": 'W/"stale"' },
    );
    assert.equal(stale.status, 204);
    const action = await send(
      "POST",
      `${book(2)}/ETagSrv.approve`,
      {},
      { "if-match": 'W/"stale"' },
    );
    assert.equal(action.status, 200);
    assert.equal((await send("DELETE", book(2))).status, 204);
  });

  it("entities still carry their ETags", async () => {
    const r = await get(book(1));
    assert.match(r.headers.get("etag") ?? "", /^W\/"/);
    assert.equal(r.body["@odata.etag"], r.headers.get("etag"));
  });
});

describe("ETAGS", () => {
  it("the server refuses to start with an unknown mode", async () => {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "..", "server.ts"), V4_MODEL],
      { env: { ...process.env, PORT: "0", ETAGS: "loose" } },
    );
    let output = "";
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise<number | null>((resolve) =>
      child.on("exit", resolve),
    );
    assert.equal(code, 1);
    assert.match(output, /ETAGS must be one of lenient, strict, off/);
  });
});

describe("ETags in the generated metadata", () => {
  it("V4 -> V2: ConcurrencyMode=Fixed on the ETag's properties", () => {
    const v2 = emitV2(
      parseMetadata(
        fs.readFileSync(path.join(V4_MODEL, "metadata.xml"), "utf8"),
      ),
    );
    assert.match(
      v2,
      /<Property Name="modifiedAt" [^>]*ConcurrencyMode="Fixed"/,
    );
    assert.doesNotMatch(v2, /<Property Name="title" [^>]*ConcurrencyMode/);
    assert.deepEqual(parseMetadata(v2).entitySets.Books.concurrency, [
      "modifiedAt",
    ]);
  });

  it("V2 -> V4: Core.OptimisticConcurrency on the entity set", () => {
    const v4 = emitV4(
      parseMetadata(
        fs.readFileSync(path.join(V2_MODEL, "metadata.xml"), "utf8"),
      ),
    );
    assert.match(
      v4,
      /<Annotation Term="Core.OptimisticConcurrency">\s*<Collection>\s*<PropertyPath>LastChangedAt<\/PropertyPath>\s*<PropertyPath>Version<\/PropertyPath>/,
    );
    assert.deepEqual(parseMetadata(v4).entitySets.OrderSet.concurrency, [
      "LastChangedAt",
      "Version",
    ]);
  });

  it("a property the annotation names that the type doesn't have: a warning, and no ETag", () => {
    const xml = fs
      .readFileSync(path.join(V4_MODEL, "metadata.xml"), "utf8")
      .replace("<PropertyPath>modifiedAt", "<PropertyPath>changedAt");
    const model = parseMetadata(xml);
    assert.equal(model.entitySets.Books.concurrency, undefined);
    assert.ok(
      model.warnings.some((w) => /ETag ignored: Books.*changedAt/.test(w)),
    );
  });
});

describe("ETags on a draft-enabled entity set", () => {
  let s: TestServer, dir: string;
  before(async () => {
    // CAP's draft service, with Books.stock as the ETag
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "etag-draft-"));
    fs.cpSync(path.join(FIXTURES, "DraftSrv"), dir, { recursive: true });
    const file = path.join(dir, "metadata.xml");
    fs.writeFileSync(
      file,
      fs
        .readFileSync(file, "utf8")
        .replace(
          "</Schema>",
          `<Annotations Target="CatalogService.EntityContainer/Books"><Annotation Term="Core.OptimisticConcurrency"><Collection><PropertyPath>stock</PropertyPath></Collection></Annotation></Annotations></Schema>`,
        ),
    );
    s = await start(dir);
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ID = "b0000000-0000-4000-8000-000000000001";
  const active = () => `${s.v4}/Books(ID=${ID},IsActiveEntity=true)`;
  const draft = () => `${s.v4}/Books(ID=${ID},IsActiveEntity=false)`;

  it("a draft takes changes without If-Match, and activating gives the active entity a new ETag", async () => {
    const before = (await get(active())).headers.get("etag");
    const edit = await send("POST", `${active()}/CatalogService.draftEdit`, {
      PreserveChanges: true,
    });
    assert.equal(edit.status, 200);
    assert.equal(
      (await send("PATCH", draft(), { title: "Draft title" })).status,
      204,
    );
    const activate = await send(
      "POST",
      `${draft()}/CatalogService.draftActivate`,
      {},
    );
    assert.equal(activate.status, 200);
    assert.equal(activate.body.title, "Draft title");
    assert.notEqual(activate.headers.get("etag"), before);
    assert.equal(
      (await get(active())).headers.get("etag"),
      activate.headers.get("etag"),
    );
  });
});

describe("ETag values: a write gives each of the ETag's properties a new one", () => {
  // An entity set whose ETag is the property V, of the given type
  const renewed = (type: string, value: unknown, attrs = "") => {
    const model = parseMetadata(`<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="S" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="T">
        <Key><PropertyRef Name="ID"/></Key>
        <Property Name="ID" Type="Edm.Int32" Nullable="false"/>
        <Property Name="V" Type="${type}" ${attrs}/>
      </EntityType>
      <EntityContainer Name="C">
        <EntitySet Name="Ts" EntityType="S.T">
          <Annotation Term="Org.OData.Core.V1.OptimisticConcurrency">
            <Collection><PropertyPath>V</PropertyPath></Collection>
          </Annotation>
        </EntitySet>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`);
    const row = { ID: 1, V: value } as Row;
    renewETag(model, "Ts", model.entityTypes["S.T"], row);
    return row.V;
  };

  it("a timestamp moves to now, or a second on from a later one", () => {
    const now = renewed("Edm.DateTimeOffset", "2020-01-01T00:00:00Z");
    assert.ok(Math.abs(Date.parse(String(now)) - Date.now()) < 5000);
    assert.equal(
      renewed("Edm.DateTimeOffset", "2999-01-01T00:00:00.000Z"),
      "2999-01-01T00:00:01.000Z",
    );
  });

  it("with fractional seconds (Precision), a timestamp moves a millisecond", () => {
    assert.equal(
      renewed(
        "Edm.DateTimeOffset",
        "2999-01-01T00:00:00.000Z",
        'Precision="3"',
      ),
      "2999-01-01T00:00:00.001Z",
    );
  });

  it("a date moves to today, or a day on from a later one", () => {
    assert.equal(
      renewed("Edm.Date", "2020-01-01"),
      new Date().toISOString().slice(0, 10),
    );
    assert.equal(renewed("Edm.Date", "2999-01-01"), "2999-01-02");
    assert.equal(
      renewed("Edm.Date", null),
      new Date().toISOString().slice(0, 10),
    );
  });

  it("an integer counts up, from 0 when it has no value", () => {
    assert.equal(renewed("Edm.Int32", 41), 42);
    assert.equal(renewed("Edm.Int16", null), 1);
    assert.equal(renewed("Edm.Byte", 7), 8);
    assert.equal(renewed("Edm.Int64", "9007199254740993"), "9007199254740994");
  });

  it("an integer at the top of its type's range starts again at the bottom", () => {
    assert.equal(renewed("Edm.Byte", 255), 0);
    assert.equal(renewed("Edm.SByte", 127), -128);
    assert.equal(renewed("Edm.Int16", 32767), -32768);
    assert.equal(renewed("Edm.Int32", 2147483647), -2147483648);
    assert.equal(
      renewed("Edm.Int64", "9223372036854775807"),
      "-9223372036854775808",
    );
  });

  it("a decimal's integer part counts up, an exponent included", () => {
    assert.equal(renewed("Edm.Decimal", "12.75"), "13");
    assert.equal(renewed("Edm.Decimal", ".5"), "1");
    assert.equal(renewed("Edm.Decimal", "-.5"), "1");
    assert.equal(renewed("Edm.Decimal", "1e3"), "1001");
    assert.equal(renewed("Edm.Decimal", "2.5E-3"), "1");
    assert.equal(renewed("Edm.Decimal", null), "1");
  });

  it("a GUID, binary value or string is a new random one", () => {
    const guid = "00000000-0000-0000-0000-000000000000";
    const newGuid = renewed("Edm.Guid", guid);
    assert.match(String(newGuid), /^[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.notEqual(newGuid, guid);
    assert.notEqual(renewed("Edm.Binary", "AAAAAAAAAAA="), "AAAAAAAAAAA=");
    assert.match(String(renewed("Edm.String", "v1")), /^[0-9a-f]{32}$/);
  });

  it("a string fits its MaxLength, and is always a new value even when that's short", () => {
    assert.equal(String(renewed("Edm.String", "x", 'MaxLength="8"')).length, 8);
    assert.equal(
      String(renewed("Edm.String", "x", 'MaxLength="max"')).length,
      32,
    );
    // One hex digit has 16 values: a random one alone would repeat 1 time in 16
    for (let i = 0; i < 200; i++)
      assert.notEqual(renewed("Edm.String", "a", 'MaxLength="1"'), "a");
  });

  it("a type without a next value (a boolean, a time of day) keeps its value", () => {
    assert.equal(renewed("Edm.Boolean", true), true);
    assert.equal(renewed("Edm.TimeOfDay", "10:00:00"), "10:00:00");
  });
});
