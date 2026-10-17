// Parses V4 $apply into its transformations (see Transformation in model.ts), which
// aggregation.ts runs: filter(Status ne 'Cancelled')/groupby((Currency),aggregate(...))
// -> [{ kind: "filter", ... }, { kind: "groupby", ... }]. A mistake is a 400; a valid
// transformation the server doesn't run is a 501.

import { HttpError, parseInt10, splitTopLevel } from "./query.ts";
import { parseTopLevels, parseRelatives, parseTraverse } from "./hierarchy.ts";
import { parseCompute } from "./compute.ts";
import type { Aggregate, Transformation } from "./model.ts";

const METHODS = new Set(["sum", "min", "max", "average", "countdistinct"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  if (name === "ancestors" || name === "descendants")
    return parseRelatives(name, args, text, parseApply);
  if (name === "traverse") return parseTraverse(args, text);
  switch (name) {
    case "filter":
      return { kind: "filter", filter: args };
    case "identity":
      throw new HttpError(400, `Invalid $apply: ${text} (identity has no ())`);
    case "search":
      return { kind: "search", search: args };
    case "compute":
      return { kind: "compute", compute: parseCompute(args, "$apply") };
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
      const properties = splitTopLevel(props[1], ",");
      const sequence = rest === undefined ? [] : parseApply(rest);
      const [only, ...others] = sequence;
      if (!only || (only.kind === "aggregate" && !others.length))
        return {
          kind: "groupby",
          properties,
          aggregates: only ? only.aggregates : [],
        };
      // Any other sequence runs on each group, such as UI5's $$filterOnAggregate:
      // groupby((...),filter(...)), whose filter is on the group's aggregated values,
      // $these/aggregate(Amount) gt 1000
      return { kind: "groupseq", properties, sequence };
    }
    default:
      throw new HttpError(501, `$apply: ${name} is not supported`);
  }
}

// topcount(2,Amount): a count (a whole number), a sum, or a percentage (0 to 100), and the
// property, alias, path or expression whose values rank the rows
function parseRank(
  method: Extract<Transformation, { kind: "rank" }>["method"],
  args: string,
  text: string,
): Transformation {
  const [first, by, ...more] = splitTopLevel(args, ",");
  const number = method.endsWith("count") ? /^\d+$/ : /^-?\d+(\.\d+)?$/;
  if (!first || !by || more.length || !number.test(first))
    throw new HttpError(400, `Invalid $apply: ${text}`);
  const value = Number(first);
  if (method.endsWith("percent") && value > 100)
    throw new HttpError(
      400,
      `Invalid $apply: ${text} (a percentage is 0 to 100)`,
    );
  return { kind: "rank", method, value, by };
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
  // __proto__ would set the rows' prototype rather than a property
  if (!IDENTIFIER.test(agg.alias) || agg.alias === "__proto__")
    throw new HttpError(400, `Invalid $apply alias in ${expr}`);
  return agg;
}

export { parseApply, parseAggregates, IDENTIFIER };
