import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start, get } from "./helpers.ts";
import { writeMockData } from "../lib/mock-data.ts";

const edmx = (body: string, encoding = "utf-8") =>
  `<?xml version="1.0" encoding="${encoding}"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm">${body}</Schema></edmx:DataServices></edmx:Edmx>`;
const type = (key: string, name = "A") =>
  `<EntityType Name="${name}"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" ${key} Nullable="false"/></EntityType>`;
const service = (set = "As", key = 'Type="Edm.Int32"') =>
  `${type(key)}<EntityContainer Name="C"><EntitySet Name="${set}" EntityType="N.A"/></EntityContainer>`;

describe("model files", () => {
  let dir: string;
  before(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "odata-prova-"))));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let n = 0;
  const model = (content: string | Buffer) => {
    const folder = path.join(dir, `m${n++}`);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "metadata.xml"), content);
    return folder;
  };
  const utf16 = (text: string) =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);

  describe("metadata.xml in UTF-16, as PowerShell's > writes it", () => {
    it("little-endian", async () => {
      const s = await start(model(utf16(edmx(service(), "utf-16"))));
      assert.equal((await get(`${s.v4}/As`)).status, 200);
      const served = await get(`${s.v4}/$metadata`);
      assert.match(served.body, /^<\?xml version="1.0" encoding="utf-8"\?>/);
      await s.close();
    });

    it("big-endian", async () => {
      const bytes = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(edmx(service(), "utf-16"), "utf16le"),
      ]).swap16();
      const s = await start(model(bytes));
      assert.equal((await get(`${s.v4}/As`)).status, 200);
      await s.close();
    });

    it("--write-data reads it too", () => {
      const folder = model(utf16(edmx(service(), "utf-16")));
      writeMockData(folder, 2);
      assert.ok(fs.existsSync(path.join(folder, "data", "As.csv")));
    });
  });

  it("an entity set named constructor, toString or valueOf is served", async () => {
    for (const set of ["constructor", "toString", "valueOf"]) {
      const s = await start(model(edmx(service(set))));
      assert.equal((await get(`${s.v4}/${set}`)).status, 200, set);
      await s.close();
    }
  });

  describe("generated keys stay inside their type", () => {
    const ids = async (key: string, mockRows: number) => {
      const s = await start(model(edmx(service("As", key))), { mockRows });
      const res = await fetch(`${s.v4}/As?$select=ID`);
      const { value } = (await res.json()) as { value: { ID: unknown }[] };
      await s.close();
      return value.map((r) => r.ID);
    };

    it("Edm.Byte: as many rows as it has values", async () => {
      const got = await ids('Type="Edm.Byte"', 300);
      assert.equal(got.length, 255);
      assert.equal(Math.max(...(got as number[])), 255);
    });

    it("Edm.SByte and Edm.Int16 too", async () => {
      assert.equal((await ids('Type="Edm.SByte"', 300)).length, 127);
      assert.equal((await ids('Type="Edm.Int16"', 300)).length, 300);
    });

    it("a string: no longer than its MaxLength", async () => {
      const one = await ids('Type="Edm.String" MaxLength="1"', 20);
      assert.deepEqual(one, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
      const two = await ids('Type="Edm.String" MaxLength="2"', 300);
      assert.equal(two.length, 99);
      assert.equal(two.at(-1), "99");
    });

    it("a string with no MaxLength: every row gets a key", async () => {
      assert.equal((await ids('Type="Edm.String"', 300)).length, 300);
    });
  });
});
