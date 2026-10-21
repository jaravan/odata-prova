// V4 $apply (OData Data Aggregation): a pipeline of transformations separated by "/", each
// turning rows into rows, run before $filter, $orderby, $count, $skip and $top. What UI5 sends
// for grouped and aggregated tables:
//
//   filter(Status ne 'Cancelled')/groupby((Currency),aggregate(TotalAmount with sum as Total))
//
// This module runs them: apply-parse.ts parses the text, and aggregates.ts works out what
// a groupby or aggregate gives. A groupby or aggregate gives rows of a type of its own (see
// resultType in aggregates.ts): the grouping
// properties and the aliases, with no key. The query options after $apply refer to those.
// Grouping or aggregating by a path, groupby((Supplier/Name)), works on a property of that
// name holding the value it leads to (see withPaths), which the response nests:
// {"Supplier":{"Name":"..."}}. Through a collection navigation, groupby((Items/Material))
// copies each row for each related entity, and aggregate(Items/NetPrice with sum as Total)
// pools the values of all of them.
//
// Supported: filter, search, orderby, skip, top, identity, concat, compute (see compute.ts),
// groupby (with an aggregate, or any sequence of transformations for each group), aggregate with sum, min, max, average,
// countdistinct, $count and custom aggregates, topcount, bottomcount, topsum, bottomsum,
// toppercent and bottompercent (by a property or an expression), and the hierarchy
// transformations traverse, TopLevels, ancestors and descendants (see hierarchy.ts). Other
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
import type { Resolve } from "./filter.ts";
import { HttpError, own } from "./query.ts";
import { topLevels, relatives, traverse } from "./hierarchy.ts";
import { applyCompute, typedExpression } from "./compute.ts";
import { isNumericType, toComparable } from "./types.ts";
import { parseAggregates, IDENTIFIER } from "./apply-parse.ts";
import {
  aggregated,
  aggregateRow,
  propertyOf,
  resultType,
  unionType,
} from "./aggregates.ts";
import type {
  Aggregate,
  EntityType,
  Literal,
  PropertyValue,
  Property,
  Row,
  Transformation,
} from "./model.ts";

// The rows and their type after each transformation in turn. inGroup: they are a group's,
// which a filter's $these/aggregate(...) aggregates
function applyTransformations(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  transformations: Transformation[],
  inGroup = false,
): { rows: readonly Row[]; type: EntityType } {
  for (const t of transformations) {
    switch (t.kind) {
      case "filter":
        rows = applyQuery(
          svc,
          rows,
          type,
          { expand: {}, filter: t.filter },
          inGroup ? aggregateOf(type, rows) : undefined,
        ).results;
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
      case "compute":
        ({ rows, type } = applyCompute(svc, rows, type, t.compute, "$apply"));
        break;
      case "traverse":
        rows = traverse(svc, rows, type, t);
        break;
      case "toplevels":
        rows = topLevels(svc, rows, type, t);
        break;
      case "ancestors":
      case "descendants":
        rows = relatives(svc, rows, type, t, (input, seq) =>
          applyTransformations(svc, input, type, seq),
        );
        break;
      case "concat": {
        const results = t.sequences.map((seq) =>
          applyTransformations(svc, rows, type, seq, inGroup),
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
      case "groupseq":
        ({ rows, type } = eachGroup(svc, rows, type, t));
        break;
    }
  }
  return { rows, type };
}

// A groupby with a sequence: the sequence run on each group's rows, one group after the other.
// A row it passes on is the entity itself, not the copy withPaths makes, and the type stays
// the input's when the sequence keeps it. A row it makes, such as an aggregate's, gets the
// group's values.
function eachGroup(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  t: Extract<Transformation, { kind: "groupseq" }>,
): { rows: Row[]; type: EntityType } {
  const paths = withPaths(svc, rows, type, t.properties, []);
  const grouping = aggregated(paths.type, t.properties, []); // checks them, too
  // The sequence's type, from no rows: a mistake in it is a 400 even when there are none
  const shape = applyTransformations(
    svc,
    [],
    paths.type,
    t.sequence,
    true,
  ).type;
  const out: Row[] = [];
  for (const group of groupsOf(paths.rows, t.properties))
    for (const row of applyTransformations(
      svc,
      group,
      paths.type,
      t.sequence,
      true,
    ).rows) {
      const entity = paths.origin.get(row);
      if (entity) {
        out.push(entity);
        continue;
      }
      const made = { ...row };
      for (const name of t.properties)
        if (!(name in made)) made[name] = group[0][name];
      out.push(made);
    }
  if (shape === paths.type) return { rows: out, type };
  return {
    rows: out,
    type: resultType(type, {
      ...grouping.type.properties,
      ...shape.properties,
    }),
  };
}

// The rows, and their type, with a property for each path among the grouping properties and
// the aggregated ones ("Supplier/Name") holding the value it leads to, or null when a
// navigation on the way leads nowhere. A grouping path through a collection navigation
// (Items/Material) copies each row for each entity the navigation leads to (or once, with
// nulls, when it leads to none), and the other paths through it (Items/NetPrice) read that
// entity. An aggregated path through one that isn't grouped by holds the values of all of
// them. origin: the row each one comes from.
function withPaths(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  groupBy: string[],
  aggregates: Aggregate[],
): { rows: readonly Row[]; type: EntityType; origin: Map<Row, Row> } {
  const paths = [
    ...new Set([...groupBy, ...aggregates.map((a) => a.property ?? "")]),
  ].filter((name) => name.includes("/") && !own(type.properties, name));
  if (!paths.length)
    return { rows, type, origin: new Map(rows.map((r) => [r, r])) };
  const properties = { ...type.properties };
  for (const path of paths) properties[path] = pathProperty(svc, type, path);
  // The collection navigation a path goes through, with the single-valued ones before it:
  // Items of Items/Material
  const through = (path: string) => {
    const at = properties[path].collectionSegments?.[0];
    return at === undefined
      ? undefined
      : path
          .split("/")
          .slice(0, at + 1)
          .join("/");
  };
  const fanOuts = [
    ...new Set(groupBy.map((p) => properties[p] && through(p))),
  ].filter((p): p is string => p !== undefined);
  const resolve = resolver(svc, type);
  const related = (row: Row, navigation: string) => {
    const coll = resolve.collection(row, navigation);
    return "rows" in coll ? coll : { rows: [], resolve };
  };
  const origin = new Map<Row, Row>();
  const out: Row[] = [];
  for (const row of rows) {
    // One entity, or none, for each fanned-out navigation, in each combination
    let combinations: Record<string, { row: Row; resolve: Resolve } | null>[] =
      [{}];
    for (const navigation of fanOuts) {
      const r = related(row, navigation);
      const options = r.rows.length
        ? r.rows.map((e) => ({ row: e, resolve: r.resolve }))
        : [null];
      combinations = combinations.flatMap((c) =>
        options.map((o) => ({ ...c, [navigation]: o })),
      );
    }
    for (const bound of combinations) {
      const copy: Row = { ...row };
      for (const path of paths) {
        const navigation = through(path);
        if (navigation === undefined) {
          copy[path] = resolve(row, path).value as PropertyValue;
          continue;
        }
        const rest = path.slice(navigation.length + 1);
        let values: PropertyValue[];
        if (navigation in bound) {
          const entity = bound[navigation];
          values = entity
            ? [entity.resolve(entity.row, rest).value as PropertyValue]
            : [null];
        } else {
          const r = related(row, navigation);
          values = r.rows.map((e) => r.resolve(e, rest).value as PropertyValue);
        }
        // A grouping value is one value; an aggregated one is a list (see aggregateRow)
        copy[path] = groupBy.includes(path) ? values[0] : values;
      }
      origin.set(copy, row);
      out.push(copy);
    }
  }
  return { rows: out, type: { ...type, properties }, origin };
}

// The property at the end of a path, named after the path. collectionSegments marks a
// collection navigation in it; a path through more than one is a 501.
function pathProperty(
  svc: QueryHost,
  type: EntityType,
  path: string,
): Property {
  const parts = path.split("/");
  let current = type;
  const collectionSegments: number[] = [];
  for (const [i, part] of parts.slice(0, -1).entries()) {
    const nav = svc.navigation(current, part);
    if (!nav)
      throw new HttpError(
        400,
        `$apply: ${part} in ${path} is not a navigation of ${current.name}`,
      );
    if (nav.isCollection) collectionSegments.push(i);
    current = svc.model.entityTypes[nav.targetType];
  }
  if (collectionSegments.length > 1)
    throw new HttpError(
      501,
      `$apply: a path through more than one collection navigation (${path}) is not supported`,
    );
  const prop = own(current.properties, parts[parts.length - 1]);
  if (!prop)
    throw new HttpError(400, `Unknown property ${path} on ${type.name}`);
  return {
    ...prop,
    name: path,
    ...(collectionSegments.length ? { collectionSegments } : {}),
  };
}

// The rows topcount and the others keep: the highest values first (top...) or the lowest
// (bottom...), as many as the count, or until they add up to the sum or to the percentage of
// the total. A count ranks any primitive value (text alphabetically, dates by time), a sum
// or percentage a number. Rows whose value is null are left out.
function ranked(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  t: Extract<Transformation, { kind: "rank" }>,
): Row[] {
  const { valueType, valueOf } = rankedBy(svc, type, t.by);
  const counting = t.method.endsWith("count");
  if (counting ? !/^Edm\.\w+$/.test(valueType) : !isNumericType(valueType))
    throw new HttpError(
      400,
      `$apply: ${t.method} needs ${counting ? "a primitive value" : "a number"}, and ${t.by} is ${valueType}`,
    );
  const sign = t.method.startsWith("top") ? -1 : 1;
  const valued = rows
    .map((row) => ({ row, value: toComparable(valueOf(row), valueType) }))
    .filter((r) => r.value !== null)
    .sort((a, b) => {
      const x = a.value!,
        y = b.value!;
      return sign * (x < y ? -1 : x > y ? 1 : 0);
    });
  if (counting) return valued.slice(0, t.value).map((r) => r.row);
  const target = t.method.endsWith("percent")
    ? (valued.reduce((s, r) => s + Number(r.value), 0) * t.value) / 100
    : t.value;
  // The fewest rows from the start whose values add up to the target: none for 0
  const kept: Row[] = [];
  let sum = 0;
  for (const r of valued) {
    if (sum >= target) break;
    kept.push(r.row);
    sum += Number(r.value);
  }
  return kept;
}

// What rows are ranked by: a property or path (Supplier/Rating), or an expression
// (Amount mul Quantity), with its type
function rankedBy(
  svc: QueryHost,
  type: EntityType,
  by: string,
): { valueType: string; valueOf: (row: Row) => unknown } {
  if (/^[A-Za-z_]\w*(\/[A-Za-z_]\w*)*$/.test(by)) {
    const prop = by.includes("/")
      ? pathProperty(svc, type, by)
      : propertyOf(type, by);
    if (prop.collectionSegments)
      throw new HttpError(
        400,
        `$apply: ranking needs one value for each row, and ${by} goes through a collection navigation`,
      );
    const resolve = resolver(svc, type);
    return { valueType: prop.type, valueOf: (row) => resolve(row, by).value };
  }
  const expression = typedExpression(svc, type, by, "$apply");
  return {
    valueType: expression.type ?? "null",
    valueOf: (row) => expression.value(row),
  };
}

// Whether a sequence's result can hold entities of the input, not only aggregated rows:
// what a filter, search, orderby, skip, top, identity, a rank, a hierarchy transformation or
// groupby's filter passes on, and
// what a concat has from any of its sequences. Only those can be expanded.
function holdsEntities(transformations: Transformation[]): boolean {
  let entities = true;
  for (const t of transformations) {
    // compute's rows are copies with a property more, written as $apply's rows
    if (t.kind === "aggregate" || t.kind === "groupby" || t.kind === "compute")
      entities = false;
    else if (t.kind === "concat")
      entities = entities && t.sequences.some(holdsEntities);
    else if (t.kind === "groupseq")
      entities = entities && holdsEntities(t.sequence);
  }
  return entities;
}

// The rows of each distinct combination of the grouping values, in the order first seen
function groupsOf(rows: readonly Row[], properties: string[]): Row[][] {
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
  rows: readonly Row[],
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

export { applyTransformations, holdsEntities };
