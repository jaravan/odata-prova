// V4 $apply (OData Data Aggregation): a pipeline of transformations separated by "/", each
// turning rows into rows, run before $filter, $orderby, $count, $skip and $top. What UI5 sends
// for grouped and aggregated tables:
//
//   filter(Status ne 'Cancelled')/groupby((Currency),aggregate(TotalAmount with sum as Total))
//
// A groupby or aggregate gives rows of a type of its own (see resultType): the grouping
// properties and the aliases, with no key. The query options after $apply refer to those.
//
// Supported: filter, search, orderby, skip, top, identity, concat, groupby (with an
// aggregate), and aggregate with sum, min, max, average, countdistinct, $count and custom
// aggregates. Other transformations are a 501. UI5 puts what it needs besides the rows in a
// concat, in rows of their own, such as min and max, the count and the grand total:
//
//   concat(aggregate(Amount with min as UI5min__Amount,$count as UI5__count),skip(0)/top(20))
//
// A custom aggregate (Aggregation.CustomAggregate) is what UI5 asks for with no "with":
// aggregate(SalesAmount,Currency). The metadata names it and its type but not how it's
// computed, so the server aggregates the property of the same name: a number is summed, and
// anything else, such as a currency or unit, is the value all the rows share, or null when
// they differ, which is what UI5 expects of a unit.

import { applyQuery } from "./apply-query.ts";
import type { QueryHost } from "./apply-query.ts";
import { HttpError, parseInt10, splitTopLevel } from "./query.ts";
import { isIntegerType, isNumericType, toComparable } from "./types.ts";
import type {
  Aggregate,
  EntityType,
  Model,
  PrimitiveValue,
  Property,
  Row,
  Transformation,
} from "./model.ts";
import type { Qualify, Xml } from "./metadata.ts";

const METHODS = new Set(["sum", "min", "max", "average", "countdistinct"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CUSTOM_AGGREGATE = "Org.OData.Aggregation.V1.CustomAggregate";
const DOUBLE = /^Edm\.(Double|Single)$/;

// --- Metadata ------------------------------------------------------------------------------

// The parsed XML elements read here: their attributes, and the elements they hold
interface ElementXml {
  Name?: string;
  Namespace?: string;
  Target?: string;
  Term?: string;
  Qualifier?: string;
  String?: string;
  Annotation?: Xml;
  EntityType?: Xml;
  EntityContainer?: Xml;
  EntitySet?: Xml;
  Annotations?: Xml;
}

// One element or several, as fast-xml-parser gives them
function elements(x: Xml): ElementXml[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? (x as ElementXml[]) : [x as ElementXml];
}

// Sets et.customAggregates from Aggregation.CustomAggregate, whose qualifier is the
// aggregate's name and whose value its type: on an entity type or entity set, inline or in an
// <Annotations> block targeting it. One on a set is taken as its type's. schemas are the
// parsed document's; qualify resolves an alias (see termQualifier in metadata.ts).
function parseCustomAggregates(
  model: Model,
  schemas: Xml[],
  qualify: Qualify,
): void {
  const container = `${model.container.namespace}.${model.container.name}`;
  const annotate = (type: EntityType | undefined, xml: Xml) => {
    for (const a of elements(xml))
      if (type && a.Qualifier && qualify(a.Term ?? "") === CUSTOM_AGGREGATE)
        (type.customAggregates ??= {})[a.Qualifier] = a.String ?? "";
  };
  const typeOfSet = (setName: string | undefined) => {
    const es = setName === undefined ? undefined : model.entitySets[setName];
    return es && model.entityTypes[es.entityType];
  };
  for (const schema of elements(schemas)) {
    for (const et of elements(schema.EntityType))
      annotate(
        model.entityTypes[`${schema.Namespace}.${et.Name}`],
        et.Annotation,
      );
    for (const c of elements(schema.EntityContainer))
      for (const es of elements(c.EntitySet))
        annotate(typeOfSet(es.Name), es.Annotation);
    for (const block of elements(schema.Annotations)) {
      const [path, setName, ...rest] = String(block.Target).split("/");
      if (rest.length) continue;
      if (setName === undefined)
        annotate(model.entityTypes[qualify(path)], block.Annotation);
      else if (qualify(path) === container)
        annotate(typeOfSet(setName), block.Annotation);
    }
  }
}

// --- Parsing -------------------------------------------------------------------------------

function parseApply(text: string): Transformation[] {
  return splitTopLevel(text, "/").map(parseTransformation);
}

function parseTransformation(text: string): Transformation {
  if (text === "identity") return { kind: "identity" };
  const m = text.match(/^(\w+)\s*\((.*)\)$/s);
  if (!m) throw new HttpError(400, `Invalid $apply: ${text}`);
  const [, name, args] = m;
  switch (name) {
    case "filter":
      return { kind: "filter", filter: args };
    case "identity":
      throw new HttpError(400, `Invalid $apply: ${text} (identity has no ())`);
    case "search":
      return { kind: "search", search: args };
    case "orderby":
      return { kind: "orderby", orderby: args };
    case "skip":
    case "top": {
      const count = parseInt10(args, `$apply ${name}`);
      if (count === undefined)
        throw new HttpError(400, `Invalid $apply: ${text}`);
      return { kind: name, count };
    }
    case "concat": {
      const sequences = splitTopLevel(args, ",").map(parseApply);
      if (sequences.length < 2)
        throw new HttpError(400, `Invalid $apply: ${text} (concat needs two)`);
      return { kind: "concat", sequences };
    }
    case "aggregate":
      return { kind: "aggregate", aggregates: parseAggregates(args) };
    case "groupby": {
      const [list, rest, ...more] = splitTopLevel(args, ",");
      const props = list?.match(/^\((.*)\)$/s);
      if (!props || more.length)
        throw new HttpError(400, `Invalid $apply: ${text}`);
      const nested = rest?.match(/^aggregate\s*\((.*)\)$/s);
      // UI5's $$filterOnAggregate sends groupby((...),filter(...)), whose filter is on the
      // groups' aggregated values, not on the rows
      if (rest?.startsWith("filter("))
        throw new HttpError(
          501,
          `$apply: filtering groups on their aggregated values is not supported: ${rest}`,
        );
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
    m = expr.match(/^(\S+?)(?:\s+as\s+(\S+))?$/);
    if (m && IDENTIFIER.test(m[1]))
      return checkAlias(
        { property: m[1], method: "custom", alias: m[2] ?? m[1] },
        expr,
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
      case "search":
        rows = applyQuery(svc, rows, type, {
          expand: {},
          search: t.search,
        }).results;
        break;
      case "orderby":
        rows = applyQuery(svc, rows, type, {
          expand: {},
          orderby: t.orderby,
        }).results;
        break;
      case "skip":
        rows = rows.slice(t.count);
        break;
      case "top":
        rows = rows.slice(0, t.count);
        break;
      case "identity":
        break;
      case "concat": {
        const results = t.sequences.map((seq) =>
          applyTransformations(svc, rows, type, seq),
        );
        rows = results.flatMap((r) => r.rows);
        type = unionType(
          type,
          results.map((r) => r.type),
        );
        break;
      }
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
  aggregates: { agg: Aggregate; input?: Property; result: Property }[];
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
    // A custom aggregate is named after its property, and so is its result by default
    const ownName = agg.method === "custom" && agg.alias === agg.property;
    if (properties[agg.alias] || (type.properties[agg.alias] && !ownName))
      throw new HttpError(400, `$apply: alias ${agg.alias} is already in use`);
    const input =
      agg.property === undefined
        ? undefined
        : agg.method === "custom"
          ? customInput(type, agg.property)
          : propertyOf(type, agg.property);
    const result = resultProperty(agg, input, type);
    properties[agg.alias] = result;
    return { agg, input, result };
  });
  return { type: resultType(type, properties), groupBy, aggregates: inputs };
}

// A type of the rows a transformation gives: these properties, and no key or navigation
function resultType(
  type: EntityType,
  properties: Record<string, Property>,
): EntityType {
  return {
    ...type,
    keys: [],
    properties,
    navigationProperties: [],
    navigations: {},
    disabledNavigations: {},
    draftNavigations: undefined,
  };
}

// The type of a concat's rows: the input type when no sequence changed it, else every
// sequence's properties. Each row has only its own sequence's (see aggregated in v4.ts).
function unionType(input: EntityType, types: EntityType[]): EntityType {
  if (types.every((t) => t === input)) return input;
  const properties: Record<string, Property> = {};
  for (const t of types)
    for (const p of Object.values(t.properties)) properties[p.name] ??= p;
  return resultType(input, properties);
}

// The property a custom aggregate aggregates: the one of its name
function customInput(type: EntityType, name: string): Property {
  if (type.customAggregates?.[name] === undefined)
    throw new HttpError(
      400,
      `$apply: ${name} is not a custom aggregate of ${type.name} (Aggregation.CustomAggregate)`,
    );
  const prop = type.properties[name];
  if (!prop)
    throw new HttpError(
      501,
      `$apply: custom aggregate ${name} has no property of its name to aggregate`,
    );
  return prop;
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
// number an Edm.Decimal, and a min or max has the type of what it compares. A custom
// aggregate has the type its annotation names.
function resultProperty(
  agg: Aggregate,
  input: Property | undefined,
  type: EntityType,
): Property {
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
    case "custom": {
      const declared = type.customAggregates?.[input.name] ?? "";
      return /^Edm\.\w+$/.test(declared)
        ? typed(declared)
        : { ...input, ...base };
    }
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
      return typed(DOUBLE.test(input.type) ? "Edm.Double" : "Edm.Decimal");
  }
}

// One result row for a group: its grouping values, and each aggregate over its rows
function aggregateRow(rows: Row[], out: Aggregated): Row {
  const row: Row = {};
  for (const name of out.groupBy) row[name] = rows[0][name];
  for (const { agg, input, result } of out.aggregates) {
    if (!input) {
      row[agg.alias] = String(rows.length);
      continue;
    }
    // Every aggregation method leaves out nulls
    const values = rows
      .map((r) => r[input.name] as PrimitiveValue)
      .filter((v) => v !== null && v !== undefined);
    const value = aggregateValues(agg.method, values, input);
    // A sum is a decimal string; a custom aggregate's type may want a number
    row[agg.alias] =
      typeof value === "string" &&
      (DOUBLE.test(result.type) || isIntegerType(result.type))
        ? Number(value)
        : value;
  }
  return row;
}

function aggregateValues(
  method: Aggregate["method"],
  values: PrimitiveValue[],
  input: Property,
): PrimitiveValue {
  const double = DOUBLE.test(input.type);
  switch (method) {
    case "custom":
      // A number is summed; anything else is the value the rows share, or null
      if (isNumericType(input.type))
        return aggregateValues("sum", values, input);
      return new Set(values.map((v) => JSON.stringify(v))).size === 1
        ? values[0]
        : null;
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
      if (!double) return decimalAverage(values);
      return values.reduce<number>((s, v) => s + Number(v), 0) / values.length;
    }
    default:
      throw new Error(`unexpected aggregation method ${method}`);
  }
}

// The exact sum of integers and decimals (kept as strings, see toInternal), as a decimal
// string: "0.10" + "0.20" is "0.30", not 0.30000000000000004
function decimalSum(values: PrimitiveValue[]): string {
  const sum = exactSum(values);
  return sum ? decimalText(sum.total, sum.scale) : sumOfNumbers(values);
}

// Their average, from the exact sum, rounded half away from zero to AVERAGE_DIGITS digits
// more than the values have, without trailing zeros: 300.30 and 0 give "150.15", 10, 0 and 0
// give "3.3333333333333333"
const AVERAGE_DIGITS = 16;

function decimalAverage(values: PrimitiveValue[]): string {
  const sum = exactSum(values);
  if (!sum) return String(Number(sumOfNumbers(values)) / values.length);
  const count = BigInt(values.length);
  const negative = sum.total < 0n;
  const scaled =
    (negative ? -sum.total : sum.total) * 10n ** BigInt(AVERAGE_DIGITS);
  let quotient = scaled / count;
  if ((scaled % count) * 2n >= count) quotient += 1n;
  return decimalText(
    negative ? -quotient : quotient,
    sum.scale + AVERAGE_DIGITS,
  ).replace(/\.?0+$/, "");
}

// The sum as a whole number of units of 10^-scale, or undefined when a value is in exponent
// notation, which is then added up as numbers
function exactSum(
  values: PrimitiveValue[],
): { total: bigint; scale: number } | undefined {
  const texts = values.map(String);
  if (texts.some((t) => /e/i.test(t))) return undefined;
  const scale = Math.max(...texts.map((t) => t.split(".")[1]?.length ?? 0));
  let total = 0n;
  for (const t of texts) {
    const [whole, fraction = ""] = t.replace(/^[+-]/, "").split(".");
    const units = BigInt(whole + fraction.padEnd(scale, "0"));
    total += t.startsWith("-") ? -units : units;
  }
  return { total, scale };
}

function sumOfNumbers(values: PrimitiveValue[]): string {
  return String(values.reduce<number>((s, v) => s + Number(v), 0));
}

// units of 10^-scale as a decimal string: 15015n with scale 2 is "150.15"
function decimalText(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

export { parseApply, applyTransformations, parseCustomAggregates };
