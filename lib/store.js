// In-memory storage for every entity set in the model, seeded from files in <modelDir>/data.
// Seed files are looked up per entity set:
//   data/<EntitySet>.csv | data/<EntitySet>.json
//   data/<Namespace>.<EntityType>.csv | .json    (CAP-style naming, so CAP seed files can be reused)
//   data/<Namespace>-<EntityType>.csv | .json

// CSV is semicolon or comma separated with a header row;
// JSON is an array of objects.
// Values are converted to the property's Edm type on load, so dates may be written as ISO
// strings.
// An entity set without a seed file starts empty, or with generated rows (see generate.js).

// One store per model is saved, shared by every protocol that serves it.

import fs from "node:fs";
import path from "node:path";
import { propToInternal } from "./types.ts";
import { generateData } from "./generate.js";
import { asActive } from "./draft.js";

// Quoting follows RFC 4180, as spreadsheets write it: a field in double quotes can hold the
// separator, line breaks and "" for a quote. Unquoted fields are trimmed, blank lines skipped.
function parseCsv(text) {
  text = text.replace(/^﻿/, ""); // Excel starts a UTF-8 CSV with a byte order mark
  const sep = /^[^\r\n]*;/.test(text) ? ";" : ",";
  const records = [];
  let fields = [],
    i = 0,
    line = 1;
  for (;;) {
    let value;
    while (text[i] === " " || text[i] === "\t") i++;
    if (text[i] === '"') {
      const start = line;
      value = "";
      for (i++; ; i++) {
        if (i >= text.length)
          throw new Error(`line ${start}: quoted field is never closed`);
        if (text[i] === '"') {
          if (text[i + 1] !== '"') break;
          i++;
        } else if (text[i] === "\n") line++;
        value += text[i];
      }
      i++;
      while (text[i] === " " || text[i] === "\t") i++;
      if (i < text.length && !/[\r\n]/.test(text[i]) && text[i] !== sep)
        throw new Error(
          `line ${line}: text after a closing quote (quote the whole field, and double the quotes in it)`,
        );
    } else {
      let end = i;
      while (
        end < text.length &&
        text[end] !== sep &&
        text[end] !== "\r" &&
        text[end] !== "\n"
      )
        end++;
      value = text.slice(i, end).trim();
      i = end;
    }
    fields.push(value);
    if (text[i] === sep) {
      i++;
      continue;
    }
    if (fields.length > 1 || fields[0] !== "") records.push(fields);
    fields = [];
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
    line++;
    if (i >= text.length) break;
  }
  if (records.length === 0) return [];
  const [headers, ...rows] = records;
  return rows.map((cells) => {
    const row = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function loadSeedFile(dataDir, candidates) {
  for (const base of candidates) {
    for (const ext of ["csv", "json"]) {
      const file = path.join(dataDir, `${base}.${ext}`);
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, "utf8");
        try {
          return {
            file,
            rows: ext === "csv" ? parseCsv(text) : JSON.parse(text),
          };
        } catch (e) {
          const err = new Error(`${file}: ${e.message}`);
          err.code = "ESEED"; // a plain message at startup, not a stack trace
          throw err;
        }
      }
    }
  }
  return { file: undefined, rows: [] };
}

class Store {
  // mockRows: rows to generate for each entity set without a seed file (0: leave it empty)
  constructor(model, modelDir, log = console.log, { mockRows = 0 } = {}) {
    this.model = model;
    this.data = {};
    // The entity sets whose rows were generated
    this.generated = [];
    const dataDir = path.join(modelDir, "data");
    const files = {};
    for (const es of Object.values(model.entitySets)) {
      const et = model.entityTypes[es.entityType];
      const { file, rows } = loadSeedFile(dataDir, [
        es.name,
        et.fullName,
        `${et.namespace}-${et.name}`,
      ]);
      files[es.name] = file;
      this.data[es.name] = rows.map((row, i) => {
        try {
          return this.normalize(et, row);
        } catch (e) {
          // Row 1 is the CSV header, so data rows count from 2 there
          const err = new Error(
            `${file}: row ${file.endsWith(".csv") ? i + 2 : i + 1}: ${
              e.message
            }`,
          );
          err.code = "ESEED"; // a plain message at startup, not a stack trace
          throw err;
        }
      });
      // Seed files of a draft entity set hold its active entities (CAP's have no draft columns)
      if (es.draft) this.data[es.name].forEach((row) => asActive(row));
      this.data[es.name].forEach((row) =>
        this.assertKeys(et, row, file || es.name),
      );
    }

    if (mockRows > 0) {
      this.generated = Object.keys(files).filter((name) => !files[name]);
      const generated = generateData(
        model,
        this.data,
        this.generated,
        mockRows,
      );
      for (const name of this.generated) {
        const es = model.entitySets[name];
        const et = model.entityTypes[es.entityType];
        this.data[name] = generated[name].map((row) => this.normalize(et, row));
        if (es.draft) this.data[name].forEach((row) => asActive(row, true));
      }
    }

    for (const [name, file] of Object.entries(files)) {
      const how = file
        ? ` from ${path.basename(file)}`
        : this.generated.includes(name)
          ? " generated (no seed file)"
          : " (no seed file)";
      log(`  ${name}: ${this.data[name].length} rows${how}`);
    }
  }

  // Converts an incoming object into an entity. Known properties converted to their Edm
  // type, unknown keys (and navigation payloads) dropped.
  normalize(entityType, input) {
    const row = {};
    for (const p of Object.values(entityType.properties)) {
      row[p.name] = propToInternal(input[p.name], p);
    }
    return row;
  }

  assertKeys(entityType, row, source) {
    for (const k of entityType.keys) {
      if (row[k] === null || row[k] === undefined) {
        throw new Error(
          `${source}: row is missing key property ${k}: ${JSON.stringify(row)}`,
        );
      }
    }
  }

  rows(setName) {
    return this.data[setName];
  }

  matchesKey(entityType, row, key) {
    return entityType.keys.every((k) => String(row[k]) === String(key[k]));
  }

  find(setName, entityType, key) {
    return this.data[setName].find((row) =>
      this.matchesKey(entityType, row, key),
    );
  }

  insert(setName, row) {
    this.data[setName].push(row);
  }

  remove(setName, entityType, key) {
    const idx = this.data[setName].findIndex((row) =>
      this.matchesKey(entityType, row, key),
    );
    if (idx === -1) return undefined;
    return this.data[setName].splice(idx, 1)[0];
  }

  // Whole-store snapshot/restore, used to make $batch changesets and draft actions atomic.
  // structuredClone, not a JSON round trip: that would turn INF and NaN into null.
  snapshot() {
    return structuredClone(this.data);
  }
  restore(snapshot) {
    this.data = snapshot;
  }
}

export { Store };
