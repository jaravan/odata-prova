// V4 $apply (OData Data Aggregation): a pipeline of transformations separated by "/", each
// turning rows into rows, run before $filter, $orderby, $count, $skip and $top. What UI5 sends
// for grouped and aggregated tables:
//
//   filter(Status ne 'Cancelled')/groupby((Currency),aggregate(TotalAmount with sum as Total))
//
// A groupby or aggregate gives rows of a type of its own (see resultType): the grouping
// properties and the aliases, with no key. The query options after $apply refer to those.
// Grouping or aggregating by a path through single-valued navigations, groupby((Supplier/
// Name)), works on a property of that name holding the value it leads to (see withPaths),
// which the response nests: {"Supplier":{"Name":"..."}}.
//
// Supported: filter, search, orderby, skip, top, identity, concat, groupby (with an
// aggregate or a filter), aggregate with sum, min, max, average, countdistinct, $count and
// custom aggregates, and topcount, bottomcount, topsum, bottomsum, toppercent and
// bottompercent, and the hierarchy function TopLevels (see hierarchy.ts). Other
// transformations are a 501. A groupby's filter is how UI5
// filters groups on their aggregated values ($$filterOnAggregate): $these is the group, so
//
//   groupby((Country),filter($these/aggregate(Amount) gt 1000))/groupby((Country),...)
//
// keeps the rows of the countries whose Amount adds up to more than 1000. UI5 puts what it
// needs besides the rows in a concat, in rows of their own, such as min and max, the count
// and the grand total:
//
//   concat(aggregate(Amount with min as UI5min__Amount,$count as UI5__count),skip(0)/top(20))
//
// A custom aggregate (Aggregation.CustomAggregate) is what UI5 asks for with no "with":
// aggregate(SalesAmount,Currency). The metadata names it and its type but not how it's
// computed, so the server aggregates the property of the same name: a number is summed, and
// anything else, such as a currency or unit, is the value all the rows share, or null when
// they differ, which is what UI5 expects of a unit.

import { applyQuery, resolver } from "./apply-query.ts";
import type { QueryHost } from "./apply-query.ts";
import { HttpError, parseInt10, splitTopLevel } from "./query.ts";
import { parseTopLevels, topLevels } from "./hierarchy.ts";
import { isIntegerType, isNumericType, toComparable } from "./types.ts";
import type {
  Aggregate,
  EntityType,
  Literal,
  Model,
  PrimitiveValue,
  PropertyValue,
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
  const m = text.match(/^([\w.]+)\s*\((.*)\)$/s);
  if (!m) throw new HttpError(400, `Invalid $apply: ${text}`);
  const [, name, args] = m;
  // A function of the Hierarchy vocabulary, by its namespace or its alias
  if (/^(?:[\w.]+\.)?TopLevels$/.test(name)) return parseTopLevels(args, text);
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
    case "topcount":
    case "bottomcount":
    case "topsum":
    case "bottomsum":
    case "toppercent":
    case "bottompercent":
      return parseRank(name, args, text);
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
      // groups' aggregated values: $these/aggregate(Amount) gt 1000
      const filter = rest?.match(/^filter\s*\((.*)\)$/s);
      if (filter)
        return {
          kind: "groupfilter",
          properties: splitTopLevel(props[1], ","),
          filter: filter[1],
        };
      if (rest && !nested)
        throw new HttpError(
          501,
          `$apply: groupby supports only an aggregate or a filter after its properties: ${rest}`,
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

// topcount(2,Amount): a count (a whole number), a sum, or a percentage (0 to 100), and the
// property, alias or path whose values rank the rows
function parseRank(
  method: Extract<Transformation, { kind: "rank" }>["method"],
  args: string,
  text: string,
): Transformation {
  const [first, path, ...more] = splitTopLevel(args, ",");
  const number = method.endsWith("count") ? /^\d+$/ : /^-?\d+(\.\d+)?$/;
  if (!first || !path || more.length || !number.test(first))
    throw new HttpError(400, `Invalid $apply: ${text}`);
  const value = Number(first);
  if (method.endsWith("percent") && value > 100)
    throw new HttpError(
      400,
      `Invalid $apply: ${text} (a percentage is 0 to 100)`,
    );
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(path))
    throw new HttpError(
      501,
      `$apply: ${method} by an expression (${path}) is not supported, only by a property`,
    );
  return { kind: "rank", method, value, path };
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
      case "rank":
        rows = ranked(svc, rows, type, t);
        break;
      case "toplevels":
        rows = topLevels(svc, rows, type, t);
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
        ({ rows, type } = withPaths(svc, rows, type, [], t.aggregates));
        const out = aggregated(type, [], t.aggregates);
        rows = [aggregateRow(rows, out)];
        type = out.type;
        break;
      }
      case "groupby": {
        ({ rows, type } = withPaths(
          svc,
          rows,
          type,
          t.properties,
          t.aggregates,
        ));
        const out = aggregated(type, t.properties, t.aggregates);
        rows = groupsOf(rows, t.properties).map((g) => aggregateRow(g, out));
        type = out.type;
        break;
      }
      case "groupfilter": {
        // The rows that pass are the entities themselves, not the copies withPaths makes
        const paths = withPaths(svc, rows, type, t.properties, []);
        const original = new Map(paths.rows.map((r, i) => [r, rows[i]]));
        aggregated(paths.type, t.properties, []); // checks the grouping properties
        rows = groupsOf(paths.rows, t.properties).flatMap((group) =>
          applyQuery(
            svc,
            group,
            paths.type,
            { expand: {}, filter: t.filter },
            aggregateOf(paths.type, group),
          ).results.map((r) => original.get(r)!),
        );
        break;
      }
    }
  }
  return { rows, type };
}

// The rows, and their type, with a property for each path among the grouping properties and
// the aggregated ones ("Supplier/Name") holding the value it leads to, or null when a
// navigation on the way leads nowhere
function withPaths(
  svc: QueryHost,
  rows: Row[],
  type: EntityType,
  groupBy: string[],
  aggregates: Aggregate[],
): { rows: Row[]; type: EntityType } {
  const paths = [...groupBy, ...aggregates.map((a) => a.property ?? "")].filter(
    (name) => name.includes("/") && !type.properties[name],
  );
  if (!paths.length) return { rows, type };
  const properties = { ...type.properties };
  for (const path of paths) properties[path] = pathProperty(svc, type, path);
  const resolve = resolver(svc, type);
  return {
    rows: rows.map((row) => {
      const out = { ...row };
      for (const path of paths)
        out[path] = resolve(row, path).value as PropertyValue;
      return out;
    }),
    type: { ...type, properties },
  };
}

// The property at the end of a path through single-valued navigations, named after the path
function pathProperty(
  svc: QueryHost,
  type: EntityType,
  path: string,
): Property {
  const parts = path.split("/");
  let current = type;
  for (const part of parts.slice(0, -1)) {
    const nav = svc.navigation(current, part);
    if (!nav)
      throw new HttpError(
        400,
        `$apply: ${part} in ${path} is not a navigation of ${current.name}`,
      );
    if (nav.isCollection)
      throw new HttpError(
        501,
        `$apply: a path through a collection navigation (${path}) is not supported`,
      );
    current = svc.model.entityTypes[nav.targetType];
  }
  const prop = current.properties[parts[parts.length - 1]];
  if (!prop)
    throw new HttpError(400, `Unknown property ${path} on ${type.name}`);
  return { ...prop, name: path };
}

// The rows topcount and the others keep: the highest values first (top...) or the lowest
// (bottom...), as many as the count, or until they add up to the sum or to the percentage of
// the total. Rows whose value is null are left out.
function ranked(
  svc: QueryHost,
  rows: Row[],
  type: EntityType,
  t: Extract<Transformation, { kind: "rank" }>,
): Row[] {
  const prop = t.path.includes("/")
    ? pathProperty(svc, type, t.path)
    : propertyOf(type, t.path);
  if (!isNumericType(prop.type))
    throw new HttpError(
      400,
      `$apply: ${t.method} needs a number, and ${t.path} is ${prop.type}`,
    );
  const resolve = resolver(svc, type);
  const sign = t.method.startsWith("top") ? -1 : 1;
  const valued = rows
    .map((row) => ({ row, value: resolve(row, t.path).value }))
    .filter((r) => r.value !== null && r.value !== undefined)
    .map((r) => ({ row: r.row, value: Number(r.value) }))
    .sort((a, b) => sign * (a.value - b.value));
  if (t.method.endsWith("count"))
    return valued.slice(0, t.value).map((r) => r.row);
  const target = t.method.endsWith("percent")
    ? (valued.reduce((s, r) => s + r.value, 0) * t.value) / 100
    : t.value;
  // The fewest rows from the start whose values add up to the target: none for 0
  const kept: Row[] = [];
  let sum = 0;
  for (const r of valued) {
    if (sum >= target) break;
    kept.push(r.row);
    sum += r.value;
  }
  return kept;
}

// Whether a sequence's result can hold entities of the input, not only aggregated rows:
// what a filter, search, orderby, skip, top, identity or groupby's filter passes on, and
// what a concat has from any of its sequences. Only those can be expanded.
function holdsEntities(transformations: Transformation[]): boolean {
  let entities = true;
  for (const t of transformations) {
    if (t.kind === "aggregate" || t.kind === "groupby") entities = false;
    else if (t.kind === "concat")
      entities = entities && t.sequences.some(holdsEntities);
  }
  return entities;
}

// The rows of each distinct combination of the grouping values, in the order first seen
function groupsOf(rows: Row[], properties: string[]): Row[][] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const k = JSON.stringify(properties.map((p) => row[p]));
    const group = groups.get(k);
    if (group) group.push(row);
    else groups.set(k, [row]);
  }
  return [...groups.values()];
}

// $these/aggregate(<expression>) over a group's rows, worked out once per expression: a
// custom aggregate (Amount), "Amount with sum" or "$count"
function aggregateOf(
  type: EntityType,
  rows: Row[],
): (expression: string) => Literal {
  const values = new Map<string, Literal>();
  return (expression) => {
    let value = values.get(expression);
    if (!value) {
      const [agg, ...more] = parseAggregates(
        IDENTIFIER.test(expression) ? expression : `${expression} as these__`,
      );
      if (more.length)
        throw new HttpError(
          400,
          `$apply: $these/aggregate takes one aggregate: ${expression}`,
        );
      const out = aggregated(type, [], [agg]);
      value = {
        value: aggregateRow(rows, out)[agg.alias],
        type: out.aggregates[0].result.type,
      };
      values.set(expression, value);
    }
    return value;
  };
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
  if (!prop)
    throw new HttpError(400, `Unknown property ${name} on ${type.name}`);
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

export {
  parseApply,
  applyTransformations,
  holdsEntities,
  parseCustomAggregates,
};
