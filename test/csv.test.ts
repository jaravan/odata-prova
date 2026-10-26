import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PO_MODEL } from "./helpers.ts";
import { createApp } from "../lib/app.ts";

// Seed files as spreadsheets export them: quoted fields, a byte order mark, CRLF
describe("CSV seed files", () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-"));
    fs.copyFileSync(
      path.join(PO_MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    fs.mkdirSync(path.join(dir, "data"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function load(csv: string) {
    fs.writeFileSync(path.join(dir, "data", "PurchaseOrderSet.csv"), csv);
    return createApp({
      modelDir: dir,
      v4Path: "/v4",
      log: () => {},
    }).store.rows("PurchaseOrderSet");
  }

  it("reads quoted fields holding the separator, quotes and line breaks", () => {
    const rows = load(
      "PurchaseOrderId,Supplier,TotalAmount\n" +
        '1,"Acme, Inc.",10.00\n' +
        '2,"The ""Best"" Parts",20\n' +
        '3,"Line one\nline two",30\n',
    );
    assert.deepEqual(
      rows.map((r) => [r.PurchaseOrderId, r.Supplier, r.TotalAmount]),
      [
        ["1", "Acme, Inc.", "10.00"],
        ["2", 'The "Best" Parts', "20"],
        ["3", "Line one\nline two", "30"],
      ],
    );
  });

  it("skips a byte order mark and blank lines, handles CRLF and ; separators", () => {
    const rows = load(
      '﻿PurchaseOrderId;Supplier\r\n\r\n1;"a;b"\r\n2; plain \r\n',
    );
    assert.deepEqual(
      rows.map((r) => [r.PurchaseOrderId, r.Supplier]),
      [
        ["1", "a;b"],
        ["2", "plain"],
      ],
    );
  });

  it("keeps a quote inside an unquoted field as is", () => {
    const rows = load('PurchaseOrderId;Supplier\n1;5" screens\n');
    assert.equal(rows[0].Supplier, '5" screens');
  });

  it("fails at startup on a quote that is never closed, naming the file and line", () => {
    assert.throws(
      () => load('PurchaseOrderId,Supplier\n1,ok\n2,"Acme\n'),
      (err) =>
        err instanceof Error &&
        "code" in err &&
        err.code === "ESEED" &&
        /PurchaseOrderSet\.csv: line 3: quoted field is never closed/.test(
          err.message,
        ),
    );
  });

  it("fails on text after a closing quote", () => {
    assert.throws(
      () => load('PurchaseOrderId,Supplier\n1,"Acme" Inc\n'),
      /line 2: text after a closing quote/,
    );
  });
});

describe("seed files that can't be used: the start says why, naming the file and row", () => {
  const MANY = path.join(import.meta.dirname, "fixtures", "ManyToMany");
  // A start on from's metadata and data files, with these files written (null: removed)
  const start = (from: string, files: Record<string, string | null>) => () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
    try {
      fs.copyFileSync(
        path.join(from, "metadata.xml"),
        path.join(dir, "metadata.xml"),
      );
      fs.cpSync(path.join(from, "data"), path.join(dir, "data"), {
        recursive: true,
      });
      for (const [file, text] of Object.entries(files))
        if (text === null) fs.rmSync(path.join(dir, "data", file));
        else fs.writeFileSync(path.join(dir, "data", file), text);
      return createApp({ modelDir: dir, v4Path: "/v4", log: () => {} });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const HEADER =
    "PurchaseOrderId;Supplier;CompanyCode;OrderDate;Status;Currency;TotalAmount";
  const ROW = "4500000001;Acme;1000;2025-01-01;Open;EUR;1.00";

  it("two rows with the same key: a request could reach one, and persistence keep one", () => {
    assert.throws(
      start(PO_MODEL, {
        "PurchaseOrderSet.csv": `${HEADER}\n${ROW}\n${ROW}\n`,
      }),
      /PurchaseOrderSet\.csv: rows 2 and 3 have the same key, PurchaseOrderId "4500000001"/,
    );
    // The same link twice
    assert.throws(
      start(MANY, {
        "Courses-Students.csv": "CourseId;Students_StudentId\n10;1\n10;1\n",
      }),
      /Courses-Students\.csv: rows 2 and 3 have the same key/,
    );
  });

  it("a link that doesn't fit its columns' types", () => {
    assert.throws(
      start(MANY, {
        "Courses-Students.csv": "CourseId;Students_StudentId\n10;x\n",
      }),
      /Courses-Students\.csv: row 2: Invalid Edm\.Int32 value: x/,
    );
  });

  it("JSON that isn't a list of rows", () => {
    for (const [json, message] of [
      [
        '{ "value": [] }',
        /PurchaseOrderSet\.json: a JSON data file is a list of rows/,
      ],
      ["[1]", /PurchaseOrderSet\.json: row 1: a row is an object/],
      [
        '[{ "PurchaseOrderId": "1" }, null]',
        /PurchaseOrderSet\.json: row 2: a row is an object/,
      ],
    ] as const)
      assert.throws(
        start(PO_MODEL, {
          "PurchaseOrderSet.csv": null,
          "PurchaseOrderSet.json": json,
        }),
        message,
      );
  });
});
