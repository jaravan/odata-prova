import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PO_MODEL } from "./helpers.js";
import { createApp } from "../lib/app.js";

// Seed files as spreadsheets export them: quoted fields, a byte order mark, CRLF
describe("CSV seed files", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csv-"));
    fs.copyFileSync(
      path.join(PO_MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    fs.mkdirSync(path.join(dir, "data"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  function load(csv) {
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
