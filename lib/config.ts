// A model's optional config.json: what operations change, and rules for its mock data.
//
//   {
//     "extends": "../shared/config.json",           (or a list of them)
//     "operations": { "Approve": { "set": { "Status": "Approved" } } },
//     "mock": {
//       "PurchaseOrderSet.PurchaseOrderId": "45########",
//       "Status": ["Open", "Open", "Approved"],
//       "TotalAmount": "100..50000",
//       "Currency": "EUR"
//     }
//   }
//
// extends names other config.json files, relative to the file that names it: shared rules.
// The files are merged per key, operation or mock rule, the nearer file winning: the model's
// own over what it extends, a later file of the list over an earlier one.
//
// A mock rule's key is "Set.Property" for one entity set, or "Property" for every set that
// has it; a complex property's member is "Set.Address/City" or "Address/City". Its value is
// one of (see MockValue):
//   "45########"        #s are a running number, zero-padded to their count, the rest stays
//   "100..50000"        a range, when both ends are numbers, or both dates (YYYY-MM-DD)
//   "EUR", 5, true      always this value
//   ["1000", "2000"]    one of these, a value repeated being more likely; never parsed, so
//                       ["A#1"] is the way to write a value with a # or .. in it
// Here they're read and their shape checked; that they fit the model is checked where they're
// applied.

import fs from "node:fs";
import path from "node:path";

// What an operation changes on the entity it acts on (see operations.ts)
export interface OperationRule {
  set?: Record<string, unknown>;
}

export type MockValue =
  | { kind: "count"; prefix: string; width: number; suffix: string }
  | { kind: "range"; type: "number" | "date"; min: string; max: string }
  | { kind: "constant"; value: string | number | boolean | null }
  | { kind: "list"; values: (string | number | boolean | null)[] };

export interface MockRule {
  // As written, and split: set undefined for a rule on every set; path is the property, or
  // Property/Member for a complex property's member
  key: string;
  set?: string;
  path: string;
  value: MockValue;
  // The config.json it comes from, for messages; shared: not the model's own, so a rule for a
  // set or property the model doesn't have is skipped there, not an error
  file: string;
  shared: boolean;
}

export interface Config {
  operations: Record<string, OperationRule & { file: string }>;
  mock: MockRule[];
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Scalar = string | number | boolean | null;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;

// A rule's value, from what's written; throws with what's wrong. file and key are for the
// message.
function parseMockValue(written: Json, where: string): MockValue {
  if (Array.isArray(written)) {
    if (!written.length)
      throw new Error(`${where}: an empty list, give at least one value`);
    for (const v of written)
      if (v !== null && typeof v === "object")
        throw new Error(
          `${where}: a list holds values, not ${Array.isArray(v) ? "lists" : "objects"}`,
        );
    return { kind: "list", values: written as Scalar[] };
  }
  if (written !== null && typeof written === "object")
    throw new Error(
      `${where}: write a value ("EUR"), a running number ("45########"), a range ("100..500") or a list (["A", "B"])`,
    );
  if (typeof written !== "string") return { kind: "constant", value: written };

  const runs = written.match(/#+/g) ?? [];
  if (runs.length > 1)
    throw new Error(
      `${where}: "${written}" has ${runs.length} runs of #, a running number has one ("45########"); for a value with a # in it, write a list: ["${written}"]`,
    );
  if (runs.length === 1) {
    const at = written.indexOf(runs[0]);
    return {
      kind: "count",
      prefix: written.slice(0, at),
      width: runs[0].length,
      suffix: written.slice(at + runs[0].length),
    };
  }

  const range = written.split("..");
  if (range.length === 2) {
    const [min, max] = range.map((s) => s.trim());
    const type =
      NUMBER.test(min) && NUMBER.test(max)
        ? "number"
        : DATE.test(min) && DATE.test(max)
          ? "date"
          : undefined;
    if (type) {
      const lower = type === "number" ? Number(min) <= Number(max) : min <= max;
      if (!lower)
        throw new Error(
          `${where}: "${written}" starts after it ends, write "${max}..${min}"`,
        );
      return { kind: "range", type, min, max };
    }
  }
  return { kind: "constant", value: written };
}

// A rule's key: "Set.Property", "Property", "Set.Address/City" or "Address/City"
function parseMockKey(key: string): { set?: string; path: string } {
  const dot = key.indexOf(".");
  return dot === -1
    ? { path: key }
    : { set: key.slice(0, dot), path: key.slice(dot + 1) };
}

// Reads one file and what it extends, the nearer file's keys last so they win. chain: the
// files being read, to tell a cycle.
function readChain(
  file: string,
  shared: boolean,
  chain: string[],
): { operations: Config["operations"]; mock: MockRule[] } {
  if (chain.includes(file))
    throw new Error(
      `${chain[chain.length - 1]}: extends ${file}, which extends it back: ${[...chain, file].join(" -> ")}`,
    );
  let config: { [key: string]: Json };
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8")) as typeof config;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const reason =
      err.code === "ENOENT"
        ? `no such file, extended by ${chain[chain.length - 1]}`
        : err.message;
    throw new Error(`${file}: ${reason}`, { cause: e });
  }
  if (config === null || typeof config !== "object" || Array.isArray(config))
    throw new Error(`${file}: an object is expected, { "mock": { ... } }`);

  const operations: Config["operations"] = {};
  const mock: MockRule[] = [];
  const bases = config.extends ?? [];
  for (const base of Array.isArray(bases) ? bases : [bases]) {
    if (typeof base !== "string")
      throw new Error(`${file}: extends names files: "../shared/config.json"`);
    const from = readChain(path.resolve(path.dirname(file), base), true, [
      ...chain,
      file,
    ]);
    Object.assign(operations, from.operations);
    mock.push(...from.mock);
  }

  for (const [name, rule] of Object.entries(
    (config.operations ?? {}) as Record<string, OperationRule>,
  ))
    operations[name] = { ...rule, file };

  const rules = config.mock ?? {};
  if (rules === null || typeof rules !== "object" || Array.isArray(rules))
    throw new Error(
      `${file}: mock is an object of rules, { "PurchaseOrderSet.Status": ["Open", "Approved"] }`,
    );
  for (const [key, written] of Object.entries(rules))
    mock.push({
      key,
      ...parseMockKey(key),
      value: parseMockValue(written, `${file}: mock "${key}"`),
      file,
      shared,
    });
  return { operations, mock: mergeRules(mock) };
}

// One rule per key, the last one written winning; keys match whatever their case
function mergeRules(rules: MockRule[]): MockRule[] {
  const byKey = new Map<string, MockRule>();
  for (const rule of rules) {
    const key = rule.key.toLowerCase();
    byKey.delete(key); // keeps the order a later rule was written in
    byKey.set(key, rule);
  }
  return [...byKey.values()];
}

// The model's config.json and what it extends; none: nothing configured
function loadConfig(modelDir: string): Config {
  const file = path.join(modelDir, "config.json");
  if (!fs.existsSync(file)) return { operations: {}, mock: [] };
  return readChain(file, false, []);
}

export { loadConfig, parseMockValue, parseMockKey };
