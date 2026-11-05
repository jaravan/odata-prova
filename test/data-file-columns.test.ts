// metadata.xml says what an entity has: a data file's other columns are ignored, and the log
// says which, since one may be a typo.

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../lib/app.ts";
import { get, start, type TestServer } from "./helpers.ts";

const FAMILIES = path.join(import.meta.dirname, "fixtures", "Families");

describe("a data file's columns the metadata doesn't have", () => {
  let dir: string;
  let s: TestServer;
  afterEach(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // The Families model with data files, and what starting it logs
  const started = async (files: Record<string, string>) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "columns-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.copyFileSync(
      path.join(FAMILIES, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    for (const [name, text] of Object.entries(files))
      fs.writeFileSync(path.join(dir, "data", name), text);
    const lines: string[] = [];
    s = await start(dir, { log: (line) => lines.push(line) });
    return lines.filter((line) => /has no such property/.test(line));
  };

  it("a CSV's are named, and the rows load without them", async () => {
    const [warning, ...rest] = await started({
      "Ps.csv": "ID,I1,Nope,Other\n1,9,x,y\n",
    });
    assert.match(warning, /Ps\.csv/);
    assert.match(warning, /Nope, Other/);
    assert.deepEqual(rest, []);
    const { status, body } = await get(`${s.v4}/Ps(1)`);
    assert.equal(status, 200);
    assert.equal(body.I1, 9);
    assert.equal(body.Nope, undefined);
  });

  it("a JSON file's too, from any row, each once", async () => {
    const [warning] = await started({
      "Ps.json": '[{"ID":1,"Nope":1},{"ID":2,"Nope":2,"Later":3}]',
    });
    assert.match(warning, /Ps\.json/);
    assert.match(warning, /Nope, Later/);
  });

  it("every file says its own", async () => {
    const warnings = await started({
      "Ps.csv": "ID,A\n1,x\n",
      "Ks.csv": "ID,B\n1,x\n",
    });
    assert.equal(warnings.length, 2);
  });

  it("a file that fits says nothing", async () => {
    assert.deepEqual(await started({ "Ps.csv": "ID,I1\n1,9\n" }), []);
  });

  it("a navigation, an annotation or __metadata isn't one", async () => {
    const warnings = await started({
      "Ps.json": '[{"ID":1,"Kids":[],"@odata.etag":"x","__metadata":{}}]',
    });
    assert.deepEqual(warnings, []);
  });
});

describe("the data files of the fixtures and examples", () => {
  const models = [
    ...fs
      .readdirSync(path.join(import.meta.dirname, "fixtures"))
      .map((name) => path.join(import.meta.dirname, "fixtures", name)),
  ].filter((dir) => fs.existsSync(path.join(dir, "data")));

  for (const model of models)
    it(`${path.basename(model)} has none`, async () => {
      const lines: string[] = [];
      const s = await start(model, { log: (line) => lines.push(line) });
      await s.close();
      assert.deepEqual(
        lines.filter((line) => /: ignored,/.test(line)),
        [],
      );
    });
});

describe("a data file no set reads", () => {
  it("is named in the log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typo-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.copyFileSync(
      path.join(FAMILIES, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    fs.writeFileSync(path.join(dir, "data", "Typo.json"), "[]");
    fs.writeFileSync(path.join(dir, "data", "Ps.json"), "[]");
    fs.writeFileSync(path.join(dir, "data", "notes.txt"), "mine");
    const lines: string[] = [];
    const s = await start(dir, { log: (line) => lines.push(line) });
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const found = lines.filter((line) => /no entity set reads it/.test(line));
    assert.equal(found.length, 1);
    assert.match(found[0], /Typo\.json/);
  });
});

describe("a data file in another case", () => {
  const onCaseInsensitive = fs.existsSync(path.join(FAMILIES, "METADATA.XML"));

  it(
    "isn't called unread when the set read it",
    { skip: !onCaseInsensitive },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "case-"));
      fs.mkdirSync(path.join(dir, "data"));
      fs.copyFileSync(
        path.join(FAMILIES, "metadata.xml"),
        path.join(dir, "metadata.xml"),
      );
      fs.writeFileSync(path.join(dir, "data", "ps.json"), '[{"ID":1}]');
      const lines: string[] = [];
      const s = await start(dir, { log: (line) => lines.push(line) });
      try {
        assert.equal((await get(`${s.v4}/Ps(1)`)).status, 200);
        assert.deepEqual(
          lines.filter((line) => /: ignored,/.test(line)),
          [],
        );
      } finally {
        await s.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("a row with no key in a data file", () => {
  it("stops the start with a message of its own, not a stack trace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nokey-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.copyFileSync(
      path.join(FAMILIES, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    fs.writeFileSync(path.join(dir, "data", "Ps.json"), '[{"I1":1}]');
    assert.throws(
      () => createApp({ modelDir: dir, log: () => {} }),
      (e: Error & { code?: string }) =>
        e.code === "ESEED" && /missing key property ID/.test(e.message),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("an operation rule setting a key", () => {
  it("stops the start, naming it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rule-"));
    const model = path.join(import.meta.dirname, "fixtures", "OperationsV2");
    fs.cpSync(model, dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        operations: {
          ApprovePurchaseOrder: { set: { PurchaseOrderId: "2" } },
        },
      }),
    );
    assert.throws(
      () => createApp({ modelDir: dir, log: () => {} }),
      /PurchaseOrderId is a key of .*an operation can't change/,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
