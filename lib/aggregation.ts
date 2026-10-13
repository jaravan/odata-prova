// V4 $apply (OData Data Aggregation): a pipeline of transformations separated by "/", each
// turning rows into rows, run before $filter, $orderby, $count, $skip and $top. What UI5 sends
// for grouped and aggregated tables:
//
//   filter(Status ne 'Cancelled')/groupby((Currency),aggregate(TotalAmount with sum as Total))
//
// A groupby or aggregate gives rows of a type of its own (see resultType): the grouping
// properties and the aliases, with no key. The query options after $apply refer to those.
//
// Supported: filter, groupby (with an aggregate), and aggregate with sum, min, max, average,
// countdistinct and $count. Other transformations, and custom aggregates (aggregate(Amount),
// with no "with"), are a 501.

import { applyQuery } from "./apply-query.ts";
import type { QueryHost } from "./apply-query.ts";
import { HttpError, splitTopLevel } from "./query.ts";
import { isNumericType, toComparable } from "./types.ts";
import type {
  Aggregate,
  EntityType,
  PrimitiveValue,
  Property,
  Row,
  Transformation,
} from "./model.ts";

const METHODS = new Set(["sum", "min", "max", "average", "countdistinct"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- Parsing -------------------------------------------------------------------------------

function parseApply(text: string): Transformation[] {
  return splitTopLevel(text, "/").map(parseTransformation);
}

function parseTransformation(text: string): Transformation {
  const m = text.match(/^(\w+)\s*\((.*)\)$/s);
  if (!m) throw new HttpError(400, `Invalid $apply: ${text}`);
  const [, name, args] = m;
  switch (name) {
    case "filter":
      return { kind: "filter", filter: args };
    case "aggregate":
      return { kind: "aggregate", aggregates: parseAggregates(args) };
    case "groupby": {
      const [list, rest, ...more] = splitTopLevel(args, ",");
      const props = list?.match(/^\((.*)\)$/s);
      if (!props || more.length)
        throw new HttpError(400, `Invalid $apply: ${text}`);
      const nested = rest?.match(/^aggregate\s*\((.*)\)$/s);
      if (rest && !nested)
        throw new HttpError(
          501,
          `$apply: groupby supports only an aggregate after its properties: ${rest}`,
        );
      return {
        kind: "groupby",
        properties: splitTopLevel(props[1], ","),
        aggregates: nested ? parseAggregates(nested[1]) : [],
      };
    }
    default:
      throw new HttpError(501, `$apply: ${name} is not supported`);
  }
}

// "TotalAmount with sum as Total,$count as Count"
function parseAggregates(text: string): Aggregate[] {
  return splitTopLevel(text, ",").map((expr): Aggregate => {
    let m = expr.match(/^\$count\s+as\s+(\S+)$/);
    if (m) return checkAlias({ method: "count", alias: m[1] }, expr);
    m = expr.match(/^(\S+)\s+with\s+(\S+)\s+as\s+(\S+)$/);
    if (m) {
      const [, property, method, alias] = m;
      if (METHODS.has(method))
        return checkAlias(
          { property, method: method as Aggregate["method"], alias },
          expr,
        );
      // A namespace-qualified method is a custom one, which is valid OData
      throw new HttpError(
        method.includes(".") ? 501 : 400,
        `$apply: unknown aggregation method ${method}`,
      );
    }
    if (IDENTIFIER.test(expr))
      throw new HttpError(
        501,
        `$apply: aggregate(${expr}) is a custom aggregate, which is not supported`,
      );
    throw new HttpError(400, `Invalid $apply aggregate: ${expr}`);
  });
}

function checkAlias(agg: Aggregate, expr: string): Aggregate {
  if (!IDENTIFIER.test(agg.alias))
    throw new HttpError(400, `Invalid $apply alias in ${expr}`);
  return agg;
}

// --- Running -------------------------------------------------------------------------------

// The rows and their type after each transformation in turn
function applyTransformations(
  svc: QueryHost,
  rows: Row[],
  type: EntityType,
  transformations: Transformation[],
): { rows: Row[]; type: EntityType } {
  for (const t of transformations) {
    switch (t.kind) {
      case "filter":
        rows = applyQuery(svc, rows, type, {
          expand: {},
          filter: t.filter,
        }).results;
        break;
      case "aggregate": {
        const out = aggregated(type, [], t.aggregates);
        rows = [aggregateRow(rows, out)];
        type = out.type;
        break;
      }
      case "groupby": {
        const out = aggregated(type, t.properties, t.aggregates);
        // One row per distinct combination of the grouping values, in the order first seen
        const groups = new Map<string, Row[]>();
        for (const row of rows) {
          const k = JSON.stringify(t.properties.map((p) => row[p]));
          const group = groups.get(k);
          if (group) group.push(row);
          else groups.set(k, [row]);
        }
        rows = [...groups.values()].map((group) => aggregateRow(group, out));
        type = out.type;
        break;
      }
    }
  }
  return { rows, type };
}

// What a groupby or aggregate gives, worked out from the input type before any row is read,
// so a mistake is a 400 even when there are no rows
interface Aggregated {
  type: EntityType;
  groupBy: string[];
  aggregates: { agg: Aggregate; input?: Property }[];
}

function aggregated(
  type: EntityType,
  groupBy: string[],
  aggregates: Aggregate[],
): Aggregated {
  const properties: Record<string, Property> = {};
  for (const name of groupBy) {
    if (name.includes("/"))
      throw new HttpError(
        501,
        `$apply: grouping by a path (${name}) is not supported`,
      );
    const prop = propertyOf(type, name);
    if (prop.complexType || prop.isCollection)
      throw new HttpError(
        501,
        `$apply: grouping by ${name}, which is not of a primitive type, is not supported`,
      );
    properties[name] = prop;
  }
  const inputs = aggregates.map((agg) => {
    if (properties[agg.alias] || type.properties[agg.alias])
      throw new HttpError(400, `$apply: alias ${agg.alias} is already in use`);
    const input =
      agg.property === undefined ? undefined : propertyOf(type, agg.property);
    properties[agg.alias] = resultProperty(agg, input);
    return { agg, input };
  });
  return {
    type: {
      ...type,
      keys: [],
      properties,
      navigationProperties: [],
      navigations: {},
      disabledNavigations: {},
      draftNavigations: undefined,
    },
    groupBy,
    aggregates: inputs,
  };
}

function propertyOf(type: EntityType, name: string): Property {
  const prop = type.properties[name];
  if (!prop) {
    if (name.includes("/"))
      throw new HttpError(
        501,
        `$apply: aggregating a path (${name}) is not supported`,
      );
    throw new HttpError(400, `Unknown property ${name} on ${type.name}`);
  }
  return prop;
}

// The alias's property. The types are the ones the Data Aggregation spec gives: a count is
// an Edm.Decimal, a sum or average of a Double or Single an Edm.Double and of any other
// number an Edm.Decimal, and a min or max has the type of what it compares.
function resultProperty(agg: Aggregate, input: Property | undefined): Property {
  const base = {
    name: agg.alias,
    nullable: true,
    sap: {},
    isCollection: false,
  };
  const typed = (type: string): Property => ({
    ...base,
    type,
    v2Type: type,
    elementType: type,
  });
  if (!input) return typed("Edm.Decimal"); // $count
  if (input.complexType || input.isCollection)
    throw new HttpError(
      400,
      `$apply: cannot aggregate ${input.name}, which is not of a primitive type`,
    );
  switch (agg.method) {
    case "countdistinct":
      return typed("Edm.Decimal");
    case "min":
    case "max":
      return { ...input, ...base };
    default:
      if (!isNumericType(input.type))
        throw new HttpError(
          400,
          `$apply: ${agg.method} needs a number, and ${input.name} is ${input.type}`,
        );
      return typed(
        /^Edm\.(Double|Single)$/.test(input.type)
          ? "Edm.Double"
          : "Edm.Decimal",
      );
  }
}

// One result row for a group: its grouping values, and each aggregate over its rows
function aggregateRow(rows: Row[], out: Aggregated): Row {
  const row: Row = {};
  for (const name of out.groupBy) row[name] = rows[0][name];
  for (const { agg, input } of out.aggregates) {
    if (!input) {
      row[agg.alias] = String(rows.length);
      continue;
    }
    // Every aggregation method leaves out nulls
    const values = rows
      .map((r) => r[input.name] as PrimitiveValue)
      .filter((v) => v !== null && v !== undefined);
    row[agg.alias] = aggregateValues(agg.method, values, input);
  }
  return row;
}

function aggregateValues(
  method: Aggregate["method"],
  values: PrimitiveValue[],
  input: Property,
): PrimitiveValue {
  const double = /^Edm\.(Double|Single)$/.test(input.type);
  switch (method) {
    case "countdistinct":
      return String(new Set(values.map((v) => JSON.stringify(v))).size);
    case "min":
    case "max": {
      let best: PrimitiveValue = null;
      for (const v of values) {
        const c = toComparable(v, input.type) as number;
        const b = toComparable(best, input.type) as number;
        if (best === null || (method === "min" ? c < b : c > b)) best = v;
      }
      return best;
    }
    case "sum":
      if (!values.length) return null;
      return double
        ? values.reduce<number>((s, v) => s + Number(v), 0)
        : decimalSum(values);
    case "average": {
      if (!values.length) return null;
      const sum = values.reduce<number>((s, v) => s + Number(v), 0);
      return double ? sum / values.length : String(sum / values.length);
    }
    default:
      throw new Error(`unexpected aggregation method ${method}`);
  }
}

// The exact sum of integers and decimals (kept as strings, see toInternal), as a decimal
// string: "0.10" + "0.20" is "0.30", not 0.30000000000000004
function decimalSum(values: PrimitiveValue[]): string {
  const texts = values.map(String);
  if (texts.some((t) => /e/i.test(t)))
    return String(texts.reduce((s, t) => s + Number(t), 0));
  const scale = Math.max(...texts.map((t) => t.split(".")[1]?.length ?? 0));
  let total = 0n;
  for (const t of texts) {
    const [whole, fraction = ""] = t.replace(/^[+-]/, "").split(".");
    const units = BigInt(whole + fraction.padEnd(scale, "0"));
    total += t.startsWith("-") ? -units : units;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export { parseApply, applyTransformations };
