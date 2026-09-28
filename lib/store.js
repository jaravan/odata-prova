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

const fs = require("fs");
const path = require("path");
const { propToInternal } = require("./types");
const { generateData } = require("./generate");

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(sep);
    const row = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

function loadSeedFile(dataDir, candidates) {
  for (const base of candidates) {
    for (const ext of ["csv", "json"]) {
      const file = path.join(dataDir, `${base}.${ext}`);
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, "utf8");
        return {
          file,
          rows: ext === "csv" ? parseCsv(text) : JSON.parse(text),
        };
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
      this.data[es.name] = rows.map((row) => this.normalize(et, row));
      this.data[es.name].forEach((row) =>
        this.assertKeys(et, row, file || es.name),
      );
    }

    if (mockRows > 0) {
      this.generated = Object.keys(files).filter((name) => !files[name]);
      const generated = generateData(model, this.data, this.generated, mockRows);
      for (const name of this.generated) {
        const et = model.entityTypes[model.entitySets[name].entityType];
        this.data[name] = generated[name].map((row) => this.normalize(et, row));
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
      row[p.name] = p.name in input ? propToInternal(input[p.name], p) : null;
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

  // Whole-store snapshot/restore, used to make $batch changesets atomic.
  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
  restore(snapshot) {
    this.data = snapshot;
  }
}

module.exports = { Store };
