// Writes the generated mock data of a model to its data/ folder, one file per entity set
// that has no seed file yet, so it can be edited by hand. Existing files are never touched.
// Used by the odata-prova-mock-data CLI (mock-data.js).
//
// An entity set is written as CSV, or as JSON when a row holds a complex or collection
// value, or a text that would need quoting in CSV (this writer doesn't quote).

const fs = require("fs");
const path = require("path");
const { parseMetadata } = require("./metadata");
const { Store } = require("./store");

function toCsv(columns, rows) {
  const cell = (v) => (v === null || v === undefined ? "" : String(v));
  return (
    [columns, ...rows.map((row) => columns.map((c) => cell(row[c])))]
      .map((cells) => cells.join(";"))
      .join("\n") + "\n"
  );
}

// The CSV reader takes ";" as the separator when the header has one, "," otherwise. A text
// holding the separator, a line break or a quote would have to be quoted, which this
// writer doesn't do.
function csvSafe(type, rows) {
  const props = Object.values(type.properties);
  if (props.some((p) => p.isCollection || p.complexType)) return false;
  const bad = props.length > 1 ? /[;"\r\n]/ : /[;,"\r\n]/;
  return rows.every((row) =>
    props.every((p) => !bad.test(String(row[p.name] ?? ""))),
  );
}

// Returns the files written, relative to the model folder
function writeMockData(modelDir, rows) {
  const model = parseMetadata(
    fs.readFileSync(path.join(modelDir, "metadata.xml"), "utf8"),
  );
  const store = new Store(model, modelDir, () => {}, { mockRows: rows });
  const dataDir = path.join(modelDir, "data");
  const written = [];
  for (const set of store.generated) {
    const type = model.entityTypes[model.entitySets[set].entityType];
    const data = store.rows(set);
    const file = csvSafe(type, data) ? `${set}.csv` : `${set}.json`;
    const text = file.endsWith(".csv")
      ? toCsv(Object.keys(type.properties), data)
      : JSON.stringify(data, null, 2) + "\n";
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, file), text, { flag: "wx" });
    } catch (err) {
      // A read-only mount shows up as EROFS, or as ENOENT on Docker Desktop
      err.message = `cannot write ${path.join(dataDir, file)}: ${err.message} (is the model folder read-only?)`;
      throw err;
    }
    written.push({ file: path.join("data", file), rows: data.length });
  }
  return written;
}

module.exports = { writeMockData };
