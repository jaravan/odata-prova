import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMetadata } from "../lib/metadata.ts";
import { writeMockData } from "../lib/mock-data.ts";
import { start, get, send, type TestServer } from "./helpers.ts";

// Navigations without a ReferentialConstraint or a property to join on get a key of their
// own: Person.Photo on Photo_Id, Line.Order (and Order.Lines back) on Order_Number. The data
// files fill them: ann's photo is 2, ben has none; lines A and B are order 1's, C order 2's.
const MODEL = path.join(import.meta.dirname, "fixtures", "HiddenKeys");

describe("a navigation with a key of its own", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  it("joins on the column a data file fills, in V4 and V2", async () => {
    assert.equal(
      (await get(`${s.v4}/People('ann')/Photo`)).body.Name,
      "Mountain",
    );
    assert.equal((await get(`${s.v4}/People('ben')/Photo`)).status, 204);
    assert.equal(
      (await get(`${s.v2}/People('ann')/Photo`)).body.d.Name,
      "Mountain",
    );
    const expanded = await get(
      `${s.v4}/People?$expand=Photo($select=Name)&$select=UserName`,
    );
    assert.deepEqual(expanded.body.value, [
      { UserName: "ann", Photo: { Name: "Mountain" } },
      { UserName: "ben", Photo: null },
    ]);
    const filtered = await get(
      `${s.v4}/People?$filter=Photo/Name eq 'Mountain'&$select=UserName`,
    );
    assert.deepEqual(filtered.body.value, [{ UserName: "ann" }]);
  });

  it("and so does its partner, a collection, the other way", async () => {
    const lines = await get(`${s.v4}/Orders(1)/Lines?$select=Code`);
    assert.deepEqual(lines.body.value, [{ Code: "A" }, { Code: "B" }]);
    assert.equal((await get(`${s.v4}/Lines('C')/Order`)).body.Number, 2);
    const any = await get(
      `${s.v4}/Orders?$filter=Lines/any(l:l/Code eq 'C')&$select=Number`,
    );
    assert.deepEqual(any.body.value, [{ Number: 2 }]);
  });

  it("is in no response and no $metadata, which has no constraint for it", async () => {
    const ann = (await get(`${s.v4}/People('ann')`)).body;
    assert.equal("Photo_Id" in ann, false);
    assert.equal(
      "Photo_Id" in (await get(`${s.v2}/People('ann')`)).body.d,
      false,
    );
    assert.equal((await get(`${s.v4}/People?$select=Photo_Id`)).status, 400);

    const v2 = (await get(`${s.v2}/$metadata`)).body as string;
    assert.doesNotMatch(v2, /Photo_Id|Order_Number|ReferentialConstraint/);
    assert.match(
      v2,
      /<End Role="ToRole_Person_Photo" Type="H.Photo" Multiplicity="0..1"\/>/,
    );
    // The generated V2 document reads back to the same keys
    const again = parseMetadata(v2).entityTypes["H.Person"];
    assert.deepEqual(again.navigations.Photo.join, [["Photo_Id", "Id"]]);
  });

  it("keeps its value through a PATCH and a PUT", async () => {
    assert.equal(
      (await send("PATCH", `${s.v4}/People('ann')`, { Name: "Anna" })).status,
      204,
    );
    assert.equal(
      (await send("PUT", `${s.v4}/People('ann')`, { Name: "Ann" })).status,
      204,
    );
    assert.equal((await get(`${s.v4}/People('ann')/Photo`)).body.Id, 2);
  });
});

describe("a key of its own in generated data", () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hidden-keys-"));
    fs.copyFileSync(
      path.join(MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("points at real rows", async () => {
    const s = await start(dir, { mockRows: 5 });
    try {
      const people = (await get(`${s.v4}/People?$expand=Photo`)).body.value;
      assert.equal(people.length, 5);
      for (const p of people) assert.ok(p.Photo, `${p.UserName} has a photo`);
      const lines = (await get(`${s.v4}/Lines?$expand=Order`)).body.value;
      for (const l of lines) assert.ok(l.Order, `line ${l.Code} has an order`);
    } finally {
      await s.close();
    }
  });

  it("is a column of the files odata-prova-mock-data writes", () => {
    writeMockData(dir, 3);
    const header = fs
      .readFileSync(path.join(dir, "data", "People.csv"), "utf8")
      .split("\n")[0];
    assert.equal(header, "UserName;Name;Photo_Id");
  });
});
