#!/usr/bin/env node
// Writes the generated mock data of a model to its data/ folder, one file per entity set
// that has no seed file yet, so it can be edited by hand. Existing files are never touched.
//
//   odata-prova-mock-data <modelDir> [rows]      (or: node mock-data.js <modelDir> [rows])
//
// An entity set is written as CSV, or as JSON when a row holds a complex or collection
// value, or a text that would need quoting in CSV (this writer doesn't quote).

import path from "node:path";
import { writeMockData } from "./lib/mock-data.ts";
import { findModelDir } from "./lib/app.js";

const [dir, rowsArg = "20"] = process.argv.slice(2);
const rows = Number(rowsArg);
if (!dir || !Number.isInteger(rows) || rows < 1) {
  console.error("usage: odata-prova-mock-data <modelDir> [rows]");
  process.exit(2);
}
try {
  const modelDir = findModelDir(path.resolve(dir));
  const written = writeMockData(modelDir, rows);
  if (!written.length)
    console.log("Every entity set already has a data file, nothing to write");
  for (const { file, rows } of written)
    console.log(`wrote ${file} (${rows} rows)`);
} catch (err) {
  console.error(err.code ? err.message : err.stack);
  process.exit(1);
}
