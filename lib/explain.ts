// odata-prova --explain: how the generated rows are made, property by property (see sourceOf
// in generate.ts), and what to add to config.json for the ones on filler values.
//
// By default it's short: the filler values only, each with its label (what the app shows) and
// a sample, then a "mock" block to paste, with a guess for each. --explain all: every
// property, how it's made, where that's decided, and a sample, and the rules of shared files
// that this model doesn't use.

import fs from "node:fs";
import path from "node:path";
import type { Model, Property, PropertyValue } from "./model.ts";
import { parseMetadata } from "./metadata.ts";
import { loadConfig, type MockRule } from "./config.ts";
import { resolveMockRules, type MockRules } from "./mock-rules.ts";
import { sourceOf, humanize, type Source } from "./generate.ts";
import { Store } from "./store.ts";

// One property of a generated set, as --explain shows it
interface Line {
  set: string;
  path: string;
  label: string;
  prop: Property;
  source: Source;
  sample: string;
}

// A sample value as it reads: text as it is, a list's values, (empty)
function sampleText(value: PropertyValue | undefined): string {
  if (value === null || value === undefined) return "(empty)";
  if (Array.isArray(value)) return value.map(sampleText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

// Every property of the generated sets, a complex property's members each on a line
function lines(
  model: Model,
  rules: MockRules,
  store: Store,
): { set: string; lines: Line[] }[] {
  return store.generated.map((set) => {
    const type = model.entityTypes[model.entitySets[set].entityType];
    const row = store.rows(set)[0] ?? {};
    const out: Line[] = [];
    const add = (
      path: string,
      prop: Property,
      value: PropertyValue | undefined,
    ) =>
      out.push({
        set,
        path,
        label: prop.label ?? humanize(prop.name),
        prop,
        source: sourceOf(model, rules, set, path),
        sample: sampleText(value),
      });
    for (const prop of Object.values(type.properties)) {
      if (prop.complexType && !prop.isCollection) {
        const value = (row[prop.name] ?? {}) as Record<string, PropertyValue>;
        for (const member of Object.values(prop.complexType.properties))
          add(`${prop.name}/${member.name}`, member, value[member.name]);
      } else add(prop.name, prop, row[prop.name]);
    }
    return { set, lines: out };
  });
}

// A first rule for a filler property, to paste and edit: a running number as wide as a
// short code (two letters of its name, then #s), or a list of texts to fill in
function guess(line: Line): string {
  const max = Number(line.prop.maxLength);
  if (max > 0 && max <= 12) {
    const width = Math.min(max, 10);
    const letters = line.prop.name.replace(/[^A-Za-z]/g, "").slice(0, 2);
    return JSON.stringify(
      width > 4
        ? `${letters.toUpperCase()}${"#".repeat(width - letters.length)}`
        : "#".repeat(width),
    );
  }
  return `["...", "..."]`;
}

// Text in columns, each as wide as its widest cell
function table(rows: string[][], indent = "  "): string[] {
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((r) => r[i].length)),
  );
  return rows.map(
    (r) =>
      indent +
      r
        .map((cell, i) => (i < r.length - 1 ? cell.padEnd(widths[i]) : cell))
        .join("   ")
        .trimEnd(),
  );
}

// Where a rule comes from, as a path from the model folder (config.json, ../shared.json)
function fromText(source: Source, modelDir: string): string {
  if (!source.from) return "";
  return path.isAbsolute(source.from)
    ? path.relative(modelDir, source.from) || source.from
    : source.from;
}

// How many generated properties are on filler values, as --explain counts them: for the
// startup's hint (see server.ts)
function fillerCount(model: Model, store: Store, modelDir: string): number {
  const rules = resolveMockRules(model, loadConfig(modelDir).mock);
  return lines(model, rules, store).flatMap((s) =>
    s.lines.filter((l) => l.source.filler),
  ).length;
}

// The --explain text for the model in modelDir, generating rows rows per set
function explain(modelDir: string, rows: number, all: boolean): string {
  const model = parseMetadata(
    fs.readFileSync(path.join(modelDir, "metadata.xml"), "utf8"),
  );
  const config = loadConfig(modelDir);
  const rules = resolveMockRules(model, config.mock, rows);
  const store = new Store(model, modelDir, () => {}, {
    mockRows: rows,
    mockRules: rules,
  });
  if (!store.generated.length)
    return rows
      ? "Every entity set has a data file: nothing is generated."
      : "--mock-rows is 0: nothing is generated.";
  const sets = lines(model, rules, store);
  const out: string[] = [];

  if (all) {
    for (const { set, lines } of sets) {
      out.push(set);
      out.push(
        ...table(
          lines.map((l) => [
            l.path,
            l.label,
            l.source.filler ? `${l.source.how}, filler` : l.source.how,
            fromText(l.source, modelDir),
            l.sample,
          ]),
        ),
        "",
      );
    }
    // A shared file's rules that apply to nothing here
    const used = new Set<MockRule>(
      Object.values(rules).flatMap((props) => Object.values(props)),
    );
    const unused = config.mock.filter((r) => r.shared && !used.has(r));
    if (unused.length)
      out.push(
        "Unused, nothing here has them:",
        ...unused.map(
          (r) => `  ${path.relative(modelDir, r.file)}: "${r.key}"`,
        ),
        "",
      );
    const kept = Object.keys(model.entitySets).filter(
      (s) => !store.generated.includes(s) && !model.entitySets[s].contained,
    );
    if (kept.length)
      out.push(`From data files, not generated: ${kept.join(", ")}`);
    return out.join("\n").trimEnd();
  }

  const fillers = sets.flatMap((s) => s.lines.filter((l) => l.source.filler));
  if (!fillers.length)
    return "No property uses filler values. To see how every property is generated: --explain all";
  out.push(
    `${fillers.length === 1 ? "1 property uses" : `${fillers.length} properties use`} filler values:`,
    "",
    ...table(
      fillers.map((l) => [`${l.set}.${l.path}`, `"${l.label}"`, l.sample]),
    ),
    "",
    "To change them, add to config.json:",
    "",
    '  "mock": {',
    fillers.map((l) => `    "${l.set}.${l.path}": ${guess(l)}`).join(",\n"),
    "  }",
    "",
    "Everything else looks fine. To see how every property is generated: --explain all",
  );
  return out.join("\n");
}

export { explain, fillerCount };
