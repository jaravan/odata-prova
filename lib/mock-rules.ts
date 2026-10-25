// The mock rules of config.json (see config.ts), checked against the model and resolved per
// entity set: which rule each property of each set follows. Done at startup, so a mistake
// shows there, with how to fix it, and not as data that quietly ignores the rule.
//
// A rule in the model's own config.json that doesn't fit is an error. One in a shared file
// (extends) that names a set or property this model doesn't have is skipped: a shared file
// serves many models. A "Set.Property" rule wins over a "Property" rule for that set.

import type { EntityType, Model, Property } from "./model.ts";
import { configError, parseMockValue, type MockRule } from "./config.ts";
import { SAP_FIELDS } from "./sap-fields.ts";
import { foreignKeys } from "./generate.ts";
import { propToInternal } from "./types.ts";

// Per entity set, per property ("Status", or "Address/City" for a complex property's member)
export type MockRules = Record<string, Record<string, MockRule>>;

const INT_MAX: Record<string, number> = {
  "Edm.Byte": 255,
  "Edm.SByte": 127,
  "Edm.Int16": 32767,
  "Edm.Int32": 2147483647,
  "Edm.Int64": Number.MAX_SAFE_INTEGER,
};
const NUMBERS = [
  ...Object.keys(INT_MAX),
  "Edm.Decimal",
  "Edm.Double",
  "Edm.Single",
];
const DATES = ["Edm.Date", "Edm.DateTimeOffset"];

// The built-in rules (see sap-fields.ts), read as a shared file's: skipped where they don't
// apply
const BUILTIN: MockRule[] = Object.entries(SAP_FIELDS).map(
  ([key, written]) => ({
    key,
    path: key,
    value: parseMockValue(written, `built-in "${key}"`),
    file: "built-in",
    shared: true,
    builtin: true,
  }),
);

// Whether a built-in rule's running number suits prop: a number, or a text of at most 12, an
// ID's length. A longer text is a name (a Supplier of 100 is the company's), which the
// generator fills in better.
function idSized(rule: MockRule, prop: Property): boolean {
  if (rule.value.kind !== "count") return true;
  const type = prop.elementType || prop.type;
  if (type !== "Edm.String") return true;
  const max = Number(prop.maxLength);
  return max > 0 && max <= 12;
}

// Edit distance, for "Did you mean"
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return row[b.length];
}

// ' Did you mean "Status"?', for the closest of names to name, or "" when none is close
function suggest(name: string, names: string[]): string {
  const lower = name.toLowerCase();
  let best: string | undefined;
  let bestDistance = Math.max(2, Math.floor(name.length / 3)) + 1;
  for (const candidate of new Set(names)) {
    const d = distance(lower, candidate.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best ? ` Did you mean "${best}"?` : "";
}

const find = <T extends { name: string }>(items: T[], name: string) =>
  items.find((i) => i.name.toLowerCase() === name.toLowerCase());

// Why the rule's value can't go into prop, or undefined when it can
function misfit(
  rule: MockRule,
  prop: Property,
  isKey: boolean,
): string | undefined {
  const value = rule.value;
  const type = prop.elementType || prop.type;
  const max = Number(prop.maxLength);
  if (isKey && value.kind !== "count") {
    const width = Math.min(max > 0 ? max : 10, 10);
    return `a key needs a running number, so every row's is different: e.g. "${"#".repeat(width)}"`;
  }
  if (prop.isCollection || prop.complexType)
    return `${prop.name} holds ${prop.isCollection ? "a collection" : "a complex value"}: give a rule for a member instead, e.g. "${prop.name}/${Object.keys(prop.complexType?.properties ?? { Member: 0 })[0]}"`;

  switch (value.kind) {
    case "count": {
      const written = `${value.prefix}${"#".repeat(value.width)}${value.suffix}`;
      const length = written.length;
      if (type === "Edm.String")
        return max > 0 && length > max
          ? `"${written}" is ${length} long, MaxLength is ${max}`
          : undefined;
      if (!NUMBERS.includes(type))
        return `a running number is for text or number properties, ${prop.name} is ${type}`;
      if (!/^\d*$/.test(value.prefix + value.suffix))
        return `"${written}" has text around its #s, and ${prop.name} is a number (${type})`;
      const top = Number(
        `${value.prefix}${"9".repeat(value.width)}${value.suffix}`,
      );
      if (type in INT_MAX && top > INT_MAX[type])
        return `"${written}" can't fit ${type} (at most ${INT_MAX[type]})`;
      return undefined;
    }
    case "range":
      if (type === "Edm.String") return undefined;
      if (value.type === "number" && !NUMBERS.includes(type))
        return `"${value.min}..${value.max}" is a range of numbers, ${prop.name} is ${type}`;
      if (value.type === "date" && !DATES.includes(type))
        return `"${value.min}..${value.max}" is a range of dates, ${prop.name} is ${type}`;
      if (value.type === "number" && type in INT_MAX) {
        if (!/^-?\d+$/.test(value.min) || !/^-?\d+$/.test(value.max))
          return `"${value.min}..${value.max}" has decimals, ${prop.name} is ${type}`;
        if (Number(value.max) > INT_MAX[type])
          return `"${value.min}..${value.max}" can't fit ${type} (at most ${INT_MAX[type]})`;
      }
      return undefined;
    default: {
      const values = value.kind === "list" ? value.values : [value.value];
      for (const v of values) {
        if (prop.enumType && v !== null) {
          const member = prop.enumType.members.find(
            (m) => m.name === String(v),
          );
          if (!member)
            return `${JSON.stringify(v)} isn't a member of ${prop.enumType.name}: ${prop.enumType.members.map((m) => m.name).join(", ")}`;
          continue;
        }
        try {
          propToInternal(v, prop);
        } catch {
          return `${JSON.stringify(v)} doesn't fit ${prop.name} (${type})`;
        }
        if (v === null && !prop.nullable)
          return `${prop.name} can't be empty (Nullable="false")`;
        if (type === "Edm.String" && max > 0 && String(v ?? "").length > max)
          return `${JSON.stringify(v)} is ${String(v).length} long, MaxLength is ${max}`;
      }
      return undefined;
    }
  }
}

// The rules, resolved per entity set; throws, listing every mistake in the model's own file
function resolveMockRules(model: Model, ownRules: MockRule[]): MockRules {
  // The built-in ones first, so any other rule for the same property wins
  const rules = [...BUILTIN, ...ownRules];
  const sets = Object.values(model.entitySets);
  const typeOf = (set: string): EntityType =>
    model.entityTypes[model.entitySets[set].entityType];
  // The foreign keys of each set: their values come from the row they point at
  const fkProps: Record<string, Set<string>> = {};
  for (const fk of foreignKeys(model))
    for (const p of fk.props) (fkProps[fk.set] ??= new Set()).add(p);

  const resolved: MockRules = {};
  const specific = new Set<string>(); // "set path" set by a Set.Property rule
  const errors: string[] = [];
  // A rule on every set: the sets it can't fit, and whether it fits any
  const unfit = new Map<MockRule, string[]>();
  const applied = new Set<MockRule>();

  for (const rule of rules) {
    // Only the model's own file's: a shared file's rule that doesn't apply here is skipped
    const fail = (message: string) => {
      if (!rule.shared) errors.push(`mock "${rule.key}": ${message}`);
    };
    const [propName, memberName, ...more] = rule.path.split("/");
    if (more.length) {
      fail(
        `a rule goes at most one level into a complex property: "Address/City"`,
      );
      continue;
    }

    // The sets it's for: the one it names, or every set whose type has the property
    let targets: string[];
    if (rule.set) {
      const es = find(sets, rule.set);
      if (!es) {
        fail(
          `no such entity set.${suggest(
            rule.set,
            sets.map((s) => s.name),
          )}`,
        );
        continue;
      }
      targets = [es.name];
    } else {
      targets = sets
        .filter((es) =>
          find(Object.values(typeOf(es.name).properties), propName),
        )
        .map((es) => es.name);
      if (!targets.length) {
        const all = Object.values(model.entityTypes).flatMap((t) =>
          Object.keys(t.properties),
        );
        fail(
          `no entity set has a property ${propName}.${suggest(propName, all)}`,
        );
        continue;
      }
    }

    for (const set of targets) {
      const type = typeOf(set);
      const prop = find(Object.values(type.properties), propName);
      if (!prop) {
        fail(
          `${set} has no property ${propName}.${suggest(propName, Object.keys(type.properties))}`,
        );
        continue;
      }
      let target = prop;
      if (memberName !== undefined) {
        const members = Object.values(prop.complexType?.properties ?? {});
        const member = find(members, memberName);
        if (!prop.complexType || !member) {
          fail(
            prop.complexType
              ? `${prop.complexType.name} has no member ${memberName}.${suggest(
                  memberName,
                  members.map((m) => m.name),
                )}`
              : `${prop.name} isn't a complex property, it has no members`,
          );
          continue;
        }
        target = member;
      }
      const path =
        memberName === undefined ? prop.name : `${prop.name}/${target.name}`;

      // A foreign key follows the row it points at
      if (memberName === undefined && fkProps[set]?.has(prop.name)) {
        if (rule.set)
          fail(
            `${prop.name} is a foreign key: its value comes from the row it points at, so a rule can't set it`,
          );
        continue;
      }
      const isKey = memberName === undefined && type.keys.includes(prop.name);
      if (rule.builtin && !idSized(rule, target)) continue;
      const wrong = misfit(rule, target, isKey);
      if (wrong) {
        // A rule on every set skips a set it can't fit, unless it fits none (see below)
        if (rule.set) fail(wrong);
        else unfit.set(rule, [...(unfit.get(rule) ?? []), `${set}: ${wrong}`]);
        continue;
      }
      const at = `${set} ${path}`;
      if (!rule.set && specific.has(at)) continue;
      if (rule.set) specific.add(at);
      (resolved[set] ??= {})[path] = rule;
      applied.add(rule);
    }
  }
  // A key named ID, Id, Number or Key takes the built-in rule of its entity type's name:
  // PurchaseOrder.ID, or RAP's A_PurchaseOrderType.ID, that of "PurchaseOrder"
  for (const es of sets) {
    const type = typeOf(es.name);
    const name = type.name.replace(/^[ACI]_/, "").replace(/Type$/, "");
    const rule = BUILTIN.find(
      (r) => r.key.toLowerCase() === name.toLowerCase(),
    );
    if (!rule) continue;
    for (const k of type.keys) {
      const prop = type.properties[k];
      if (
        /^(id|number|key)$/i.test(k) &&
        !resolved[es.name]?.[k] &&
        !fkProps[es.name]?.has(k) &&
        idSized(rule, prop) &&
        !misfit(rule, prop, true)
      )
        (resolved[es.name] ??= {})[k] = rule;
    }
  }
  // A rule on every set that fits none of them is a mistake: say why, for each
  for (const [rule, why] of unfit)
    if (!applied.has(rule) && !rule.shared)
      errors.push(`mock "${rule.key}": ${why.join("; ")}`);
  // The file once, each mistake on a line of its own
  if (errors.length) {
    const file = rules.find((r) => !r.shared)!.file;
    const count =
      errors.length === 1
        ? "a mock rule that doesn't"
        : `${errors.length} mock rules that don't`;
    throw configError(
      `${file}: ${count} fit the model:\n${errors.map((e) => `  ${e}`).join("\n")}`,
    );
  }
  return resolved;
}

export { resolveMockRules, suggest };
