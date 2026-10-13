import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { parseMetadata } from "../lib/metadata.ts";
import { emitV2 } from "../lib/emit-v2.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
const read = (...p: string[]) =>
  fs.readFileSync(path.join(fixtures, ...p), "utf8");
const v2 = emitV2(parseMetadata(read("AnnotationsV4", "metadata.xml")));

// The emitted document, every element an array, namespace prefixes kept
type El = Record<string, El[] | string>;
const doc = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name, jpath, isLeaf, isAttribute) => !isAttribute,
}).parse(v2) as El;
const children = (el: El, tag: string) => (el[tag] || []) as El[];
const schema = children(
  children(children(doc, "edmx:Edmx")[0], "edmx:DataServices")[0],
  "Schema",
)[0];
const container = children(schema, "EntityContainer")[0];
const byName = (tag: string, name: string) => {
  const el = children(container, tag).find((e) => e.Name === name);
  assert.ok(el, `${tag} ${name} is emitted`);
  return el;
};
const blocks = children(schema, "Annotations");
// The terms annotating the target, from every block for it
const terms = (target: string) =>
  blocks
    .filter((b) => b.Target === target)
    .flatMap((b) => children(b, "Annotation").map((a) => a.Term as string))
    .sort();

const C = "com.example.anno.EntityContainer";

describe("emitV2 carries a V4 document's annotations as UI5's V2 model reads them", () => {
  it("puts every block in the V4 namespace, the only one UI5 reads blocks in", () => {
    assert.ok(blocks.length > 0);
    for (const b of blocks)
      assert.equal(b.xmlns, "http://docs.oasis-open.org/odata/ns/edm");
  });

  it("declares V4's edmx namespace on each reference, where UI5 looks for the aliases of terms", () => {
    const references = children(
      children(doc, "edmx:Edmx")[0],
      "edmx:Reference",
    );
    assert.equal(references.length, 3);
    for (const r of references)
      assert.equal(r["xmlns:edmx"], "http://docs.oasis-open.org/odata/ns/edmx");
  });

  it("moves inline annotations into blocks targeting their element", () => {
    assert.deepEqual(terms("com.example.anno.Order"), ["Common.Label"]);
    assert.deepEqual(terms("com.example.anno.Order/Items"), ["Common.Label"]);
    assert.deepEqual(terms(`${C}/Orders`), ["Capabilities.SearchRestrictions"]);
    assert.deepEqual(terms(`${C}/Approve/Comment`), ["Common.Label"]);
  });

  it("resolves a schema alias in a target (UI5 resolves only the references' aliases)", () => {
    // One from an inline annotation, one from a block targeting SAP__self.Order/Note
    assert.deepEqual(terms("com.example.anno.Order/Note"), [
      "Common.Label",
      "Common.QuickInfo",
    ]);
    assert.ok(!blocks.some((b) => String(b.Target).includes("SAP__self")));
  });

  it("targets an action, by overload or all of them, and an action import as the function import V2 has", () => {
    assert.deepEqual(terms(`${C}/Approve`), [
      "Common.IsActionCritical",
      "Common.SideEffects",
      "Core.OperationAvailable",
    ]);
    assert.deepEqual(terms(`${C}/Approve_Item`), [
      "Common.IsActionCritical",
      "Core.OperationAvailable",
    ]);
    assert.deepEqual(terms(`${C}/ResetAll`), ["Common.Label"]);
  });

  it("sap:searchable, unless the annotations say Searchable false", () => {
    assert.equal(byName("EntitySet", "Items")["sap:searchable"], "true");
    assert.equal(byName("EntitySet", "Orders")["sap:searchable"], undefined);
  });

  it("sap:applicable-path from Core.OperationAvailable, relative to the entity", () => {
    // Path="_it/CanApprove" inline, and <Path>in/Open</Path> in a block
    assert.equal(
      byName("FunctionImport", "Approve")["sap:applicable-path"],
      "CanApprove",
    );
    assert.equal(
      byName("FunctionImport", "Approve_Item")["sap:applicable-path"],
      "Open",
    );
    assert.equal(
      byName("FunctionImport", "ResetAll")["sap:applicable-path"],
      undefined,
    );
  });

  it("the emitted document parses back", () => {
    const back = parseMetadata(v2);
    assert.equal(back.sourceVersion, "2.0");
    assert.deepEqual(Object.keys(back.operations.imports).sort(), [
      "Approve",
      "Approve_Item",
      "ResetAll",
    ]);
  });

  for (const file of [
    ["DraftSrv", "metadata.xml"],
    ["real", "TripPin", "metadata.xml"],
    ["real", "NorthwindV4", "metadata.xml"],
  ]) {
    it(`keeps every annotation of ${file.slice(0, -1).join("/")}`, () => {
      const xml = read(...file);
      const count = (s: string) =>
        (s.match(/<Annotation\s+Term=/g) || []).length;
      assert.equal(count(emitV2(parseMetadata(xml))), count(xml));
    });
  }
});
