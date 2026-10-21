// In-memory storage for every entity set in the model, seeded from files in <modelDir>/data.
// Seed files are looked up per entity set:
//   data/<EntitySet>.csv | data/<EntitySet>.json
//   data/<Namespace>.<EntityType>.csv | .json    (CAP-style naming, so CAP seed files can be reused)
//   data/<Namespace>-<EntityType>.csv | .json

// CSV is semicolon or comma separated with a header row;
// JSON is an array of objects.
// Values are converted to the property's Edm type on load, so dates may be written as ISO
// strings.
// An entity set without a seed file starts empty, or with generated rows (see generate.ts).

// One store per model is saved, shared by every protocol that serves it.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { EntityType, Key, Model, PropertyValue, Row } from "./model.ts";
import { propToInternal } from "./types.ts";
import { generateData, generateLinks } from "./generate.ts";
import { asActive } from "./draft.ts";

// Quoting follows RFC 4180, as spreadsheets write it: a field in double quotes can hold the
// separator, line breaks and "" for a quote. Unquoted fields are trimmed, blank lines skipped.
function parseCsv(text: string): Record<string, string>[] {
  text = text.replace(/^\uFEFF/, ""); // Excel starts a UTF-8 CSV with a byte order mark
  const sep = /^[^\r\n]*;/.test(text) ? ";" : ",";
  const records: string[][] = [];
  let fields: string[] = [],
    i = 0,
    line = 1;
  for (;;) {
    let value: string;
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
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

// Startup errors in seed files carry code ESEED: shown as a plain message, not a stack trace
function seedError(message: string): Error {
  return Object.assign(new Error(message), { code: "ESEED" });
}

function loadSeedFile(
  dataDir: string,
  candidates: string[],
): { file: string | undefined; rows: Record<string, unknown>[] } {
  for (const base of candidates) {
    for (const ext of ["csv", "json"]) {
      const file = path.join(dataDir, `${base}.${ext}`);
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, "utf8");
        try {
          return {
            file,
            rows:
              ext === "csv"
                ? parseCsv(text)
                : (JSON.parse(text) as Record<string, unknown>[]),
          };
        } catch (e) {
          throw seedError(`${file}: ${(e as Error).message}`);
        }
      }
    }
  }
  return { file: undefined, rows: [] };
}

// A change the store made inside a transaction, with what it takes to undo it. Rows change
// in place, so an update keeps the row's old values of the fields it set (absent: the
// fields the row didn't have), and a remove the row and where it was.
type Change =
  | { op: "insert"; set: string; row: Row }
  | { op: "update"; set: string; row: Row; before: Row; absent: string[] }
  | { op: "remove"; set: string; row: Row; index: number };

// The key of a lookup: values compared as strings, as navigations compare them
const valuesKey = (values: PropertyValue[]) =>
  JSON.stringify(values.map((v) => String(v)));

// Undoes changes, last first, on data: the store's, or a copy of it (see Store.audit)
function undo(data: Record<string, Row[]>, changes: Change[]): void {
  for (const c of changes.toReversed()) {
    const rows = data[c.set];
    if (c.op === "insert") rows.splice(rows.indexOf(c.row), 1);
    else if (c.op === "remove") rows.splice(c.index, 0, c.row);
    else {
      Object.assign(c.row, c.before);
      for (const name of c.absent) delete c.row[name];
    }
  }
}

class Store {
  model: Model;
  // Rows by entity set. Private, and handed out read-only (rows, lookup, sets): a change made
  // anywhere but here would escape rollback and persistence.
  private data: Record<string, Row[]>;
  // The entity sets whose rows were generated
  generated: string[];
  // The link sets whose rows were generated (see linkSet in navigations.ts)
  generatedLinks: string[];
  // Tests only: checks at the end of each outermost transaction that undoing its log gives
  // back the store as it began. A row changed without going through the store fails it,
  // since its change is in no log: rollback wouldn't undo it, nor persistence save it.
  audit = false;
  // Every change inside a transaction: one outside would escape the log, and with it
  // persistence, which saves what the log holds. Set once the store is seeded.
  transactionsOnly = false;

  // The changes of the open transactions, oldest first; once the outermost commits, its
  // changes until they're settled (see commit)
  private log: Change[] = [];
  private held = false;
  // Where each open transaction begins in the log, outermost first
  private marks: number[] = [];
  // Tests only: the data as the outermost transaction found it (see audit)
  private begun: Record<string, Row[]> | undefined;
  // Rows by the values of some of their columns, per set and columns (see lookup). Built when
  // first asked for, dropped by a change to the set that could move a row between buckets.
  private indexes: Record<string, Map<string, Map<string, Row[]>>> = {};

  // mockRows: rows to generate for each entity set without a seed file (0: leave it empty)
  constructor(
    model: Model,
    modelDir: string,
    log: (message: string) => void = console.log,
    { mockRows = 0 }: { mockRows?: number } = {},
  ) {
    this.model = model;
    this.data = {};
    this.generated = [];
    this.generatedLinks = [];
    const dataDir = path.join(modelDir, "data");
    const files: Record<string, string | undefined> = {};
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
          throw seedError(
            `${file}: row ${file?.endsWith(".csv") ? i + 2 : i + 1}: ${
              (e as Error).message
            }`,
          );
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

    // The link sets, kept like entity sets: a data file's, or generated ones
    for (const set of Object.values(model.linkSets)) {
      const { file, rows } = loadSeedFile(dataDir, [set.name]);
      files[set.name] = file;
      this.data[set.name] = rows.map((row) => {
        const link: Row = {};
        for (const end of set.ends) {
          const type = model.entityTypes[model.entitySets[end.set].entityType];
          // A contained type's parent keys are hidden keys (see resolveContainment)
          end.columns.forEach((c, i) => {
            const k = end.keys[i];
            const prop = type.properties[k] ?? type.hiddenKeys![k];
            link[c] = propToInternal(row[c], prop);
          });
        }
        return link;
      });
      if (!file && mockRows > 0) {
        this.data[set.name] = generateLinks(model, this.data, set);
        this.generatedLinks.push(set.name);
      }
    }

    for (const [name, file] of Object.entries(files)) {
      const how = file
        ? ` from ${path.basename(file)}`
        : this.generated.includes(name) || this.generatedLinks.includes(name)
          ? " generated (no seed file)"
          : " (no seed file)";
      const what = model.linkSets[name] ? "links" : "rows";
      log(`  ${name}: ${this.data[name].length} ${what}${how}`);
    }
  }

  // Converts an incoming object into an entity. Known properties converted to their Edm
  // type, and the hidden keys (see hiddenKey in navigations.ts) kept, unknown keys (and
  // navigation payloads) dropped.
  normalize(entityType: EntityType, input: Record<string, unknown>): Row {
    const row: Row = {};
    for (const p of Object.values(entityType.properties)) {
      row[p.name] = propToInternal(input[p.name], p);
    }
    for (const p of Object.values(entityType.hiddenKeys ?? {}))
      row[p.name] = propToInternal(input[p.name], p);
    return row;
  }

  assertKeys(entityType: EntityType, row: Row, source: string): void {
    for (const k of entityType.keys) {
      if (row[k] === null || row[k] === undefined) {
        throw new Error(
          `${source}: row is missing key property ${k}: ${JSON.stringify(row)}`,
        );
      }
    }
  }

  rows(setName: string): readonly Row[] {
    return this.data[setName];
  }

  // Every set's rows
  sets(): Readonly<Record<string, readonly Row[]>> {
    return this.data;
  }

  // Adds an empty set the model doesn't have (draft administrative data). Not inside a
  // transaction: no rollback would remove the set again.
  addSet(setName: string): void {
    if (this.marks.length)
      throw new Error(`set ${setName} added inside a transaction`);
    this.data[setName] ||= [];
  }

  // The rows of setName whose columns hold values, in the set's order: what
  // rows(setName).filter() would find comparing each as a string, without scanning the set
  // each time. For navigations, which join on the same columns for every row they follow.
  lookup(
    setName: string,
    columns: string[],
    values: PropertyValue[],
  ): readonly Row[] {
    const byColumns = (this.indexes[setName] ||= new Map());
    const name = JSON.stringify(columns);
    let index = byColumns.get(name);
    if (!index) {
      index = new Map();
      for (const row of this.data[setName]) {
        const value = valuesKey(columns.map((c) => row[c]));
        const bucket = index.get(value);
        if (bucket) bucket.push(row);
        else index.set(value, [row]);
      }
      byColumns.set(name, index);
    }
    return index.get(valuesKey(values)) ?? [];
  }

  // Drops the indexes change may have made wrong: an update's on the columns it set, an
  // insert's or a remove's all of the set's
  private invalidate(change: Change): void {
    const byColumns = this.indexes[change.set];
    if (!byColumns) return;
    if (change.op !== "update") {
      delete this.indexes[change.set];
      return;
    }
    const changed = [...Object.keys(change.before), ...change.absent];
    for (const name of byColumns.keys())
      if ((JSON.parse(name) as string[]).some((c) => changed.includes(c)))
        byColumns.delete(name);
  }

  // key: the type's keys, and a contained entity's parent's keys too (see keyOf in
  // service.ts)
  matchesKey(entityType: EntityType, row: Row, key: Key): boolean {
    return (
      entityType.keys.every((k) => String(row[k]) === String(key[k])) &&
      (entityType.parentKeys ?? []).every(
        (k) => !(k in key) || String(row[k]) === String(key[k]),
      )
    );
  }

  find(setName: string, entityType: EntityType, key: Key): Row | undefined {
    return this.data[setName].find((row) =>
      this.matchesKey(entityType, row, key),
    );
  }

  insert(setName: string, row: Row): void {
    this.writable(setName);
    this.data[setName].push(row);
    this.record({ op: "insert", set: setName, row });
  }

  // Sets changes on row, a row of setName, in place, and returns it
  update(setName: string, row: Row, changes: Row): Row {
    this.writable(setName);
    const before: Row = {};
    const absent: string[] = [];
    for (const name of Object.keys(changes))
      if (name in row) before[name] = row[name];
      else absent.push(name);
    Object.assign(row, changes);
    this.record({ op: "update", set: setName, row, before, absent });
    return row;
  }

  remove(setName: string, entityType: EntityType, key: Key): Row | undefined {
    const row = this.find(setName, entityType, key);
    if (row) this.removeRow(setName, row);
    return row;
  }

  // Removes row itself, for the rows a key doesn't find: links, draft administrative data
  removeRow(setName: string, row: Row): void {
    this.writable(setName);
    const index = this.data[setName].indexOf(row);
    if (index === -1) return;
    this.data[setName].splice(index, 1);
    this.record({ op: "remove", set: setName, row, index });
  }

  // --- Transactions ---
  //
  //   const mark = store.begin();
  //   try { ...; store.commit(mark); } catch (e) { store.rollback(mark); throw e; }
  //
  // Transactions nest: an inner one is a savepoint, which only its own rollback undoes.
  // Outside a transaction changes aren't logged, as there's nothing to undo them for (see
  // transactionsOnly).
  //
  // The outermost commit hands its changes out to be saved, and holds them until settle()
  // says whether they were: kept, or undone. Nothing else may change the store meanwhile.

  // Throws, before anything changes, when setName may not change now
  private writable(setName: string): void {
    if (this.held)
      throw new Error(`${setName} changed while a commit is being saved`);
    if (!this.marks.length && this.transactionsOnly)
      throw new Error(`${setName} changed outside a transaction`);
  }

  private record(change: Change): void {
    this.invalidate(change);
    if (this.marks.length) this.log.push(change);
  }

  // Opens a transaction, and returns its mark for commit or rollback
  begin(): number {
    if (this.held)
      throw new Error("transaction begun while a commit is being saved");
    if (!this.marks.length && this.audit)
      this.begun = structuredClone(this.data);
    this.marks.push(this.log.length);
    return this.marks.length - 1;
  }

  // Ends the transaction, keeping its changes. The outermost returns all the changes it
  // made, held until settle(); an inner one undefined: they're the outermost's until it ends.
  commit(mark: number): Change[] | undefined {
    this.end(mark);
    if (this.marks.length) return undefined;
    this.held = true;
    return this.log;
  }

  // Ends the outermost commit's hold: saved keeps its changes, otherwise they're undone
  settle(saved: boolean): void {
    if (!this.held) throw new Error("settle() without a commit to settle");
    const changes = this.log;
    this.log = [];
    this.held = false;
    if (!saved) {
      undo(this.data, changes);
      changes.forEach((c) => this.invalidate(c));
      if (this.audit) this.check(this.data);
    } else if (this.audit) {
      // Undone on a copy: one structuredClone keeps the rows the log and data share
      const copy = structuredClone({ data: this.data, changes });
      undo(copy.data, copy.changes);
      this.check(copy.data);
    }
  }

  // Ends the transaction, undoing its changes
  rollback(mark: number): void {
    const start = this.end(mark);
    const undone = this.log.splice(start);
    undo(this.data, undone);
    undone.forEach((c) => this.invalidate(c));
    if (!this.marks.length && this.audit) this.check(this.data);
  }

  // Closes the innermost transaction, which must be mark's, and returns where it began
  private end(mark: number): number {
    if (mark !== this.marks.length - 1)
      throw new Error(
        `transaction ${mark} ended while ${this.marks.length - 1} is the innermost`,
      );
    return this.marks.pop()!;
  }

  private check(undone: Record<string, Row[]>): void {
    const begun = this.begun;
    this.begun = undefined;
    if (!isDeepStrictEqual(undone, begun))
      throw new Error(
        "store audit: a row changed without going through the store",
      );
  }
}

export type { Change };
export { Store };
