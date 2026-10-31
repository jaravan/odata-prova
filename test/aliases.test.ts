import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseMetadata } from "../lib/metadata.ts";
import { start, get, type TestServer } from "./helpers.ts";

// A schema alias (T for a.types) in type references, TypeDefinitions, a container-qualified
// binding target and a Singleton, as CAP, RAP and hand-written documents have them
const MODEL = path.join(import.meta.dirname, "fixtures", "AliasesV4");
const xml = fs.readFileSync(path.join(MODEL, "metadata.xml"), "utf8");

describe("a schema's alias in type references", () => {
  const model = parseMetadata(xml);

  it("BaseType, EntitySet EntityType and navigation types resolve through it", () => {
    const order = model.entityTypes["a.types.Order"];
    assert.deepEqual(order.keys, ["ID"]);
    assert.ok(order.properties.ID, "inherited from T.Base");
    assert.equal(model.entitySets.Orders.entityType, "a.types.Order");
    assert.equal(order.navigations.Lines?.targetSet, "Lines");
  });
});

describe("TypeDefinition", () => {
  const model = parseMetadata(xml);

  it("a property of one has its underlying type and facets", () => {
    const { Total, Code } = model.entityTypes["a.types.Order"].properties;
    assert.equal(Total.type, "Edm.Decimal");
    assert.deepEqual([Total.precision, Total.scale], ["15", "2"]);
    assert.equal(Code.type, "Edm.String");
    assert.equal(Code.maxLength, "4");
  });

  it("in a collection too", () => {
    const { Codes } = model.entityTypes["a.types.Line"].properties;
    assert.equal(Codes.type, "Collection(Edm.String)");
    assert.equal(Codes.elementType, "Edm.String");
    assert.equal(Codes.maxLength, "4");
  });
});

describe("served: aliases, TypeDefinitions and a Singleton", () => {
  let s: TestServer;
  const logs: string[] = [];
  before(async () => {
    s = await start(MODEL, { mockRows: 3, log: (m) => logs.push(m) });
  });
  after(() => s.close());

  it("a TypeDefinition property gets generated values, and filters work on it", async () => {
    const r = await get(`${s.v4}/Orders?$select=Total,Code`);
    assert.equal(r.status, 200);
    assert.ok(
      r.body.value.every(
        (o: { Total: unknown }) => typeof o.Total === "number",
      ),
    );
    const f = await get(`${s.v4}/Orders?$filter=Total gt 0&$count=true&$top=0`);
    assert.equal(f.body["@odata.count"], 3);
  });

  it("the V2 $metadata writes the underlying type, as V2 has no TypeDefinition", async () => {
    const res = await fetch(`${s.v2}/$metadata`);
    const v2 = await res.text();
    assert.match(
      v2,
      /<Property Name="Total" Type="Edm.Decimal"[^>]*Precision="15"/,
    );
    assert.doesNotMatch(v2, /Type="(T|a\.types)\.(Amount|Code)"/);
  });

  it("a binding target qualified with its container joins as the set's name", async () => {
    const r = await get(`${s.v4}/Orders(1)/Lines`);
    assert.equal(r.status, 200);
  });

  it("a Singleton isn't served: logged at startup, and a navigation to it is a 501 saying so", async () => {
    assert.ok(
      logs.some((l) => /Singleton Me/.test(l)),
      logs.join("\n"),
    );
    const r = await get(`${s.v4}/Orders(1)/Owner`);
    assert.equal(r.status, 501);
    assert.match(r.body.error.message, /[Ss]ingleton/);
  });
});

describe("IncludeInServiceDocument=false", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL, { mockRows: 3 });
  });
  after(() => s.close());

  it("leaves the set out of the service document, and still serves it", async () => {
    const doc = await get(`${s.v4}/`);
    assert.deepEqual(
      doc.body.value.map((e: { name: string }) => e.name),
      ["Orders", "Lines"],
    );
    assert.equal((await get(`${s.v4}/Hidden`)).status, 200);
  });
});
