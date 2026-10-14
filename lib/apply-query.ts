// Applies a request's query options to rows: $filter, $search, $count, $orderby, $skip and
// $top, for a collection or an $expand node.

import { toComparable } from "./types.ts";
import { compileFilter } from "./filter.ts";
import type { Collection, LiteralSyntax, Resolve } from "./filter.ts";
import { HttpError } from "./query.ts";
import type {
  AnyNavigation,
  EntityType,
  Literal,
  Model,
  PropertyValue,
  QueryNode,
  Row,
} from "./model.ts";

// What the query options use of the service (the ODataService in service.ts)
export interface QueryHost {
  model: Model;
  protocol: LiteralSyntax;
  navigation(type: EntityType, name: string): AnyNavigation | undefined;
  related(
    row: Row,
    type: EntityType,
    nav: AnyNavigation,
  ): { type: EntityType; rows: Row[] };
}

// Property-path resolver for $filter/$orderby: "Prop" or "Nav/Prop" (single-valued nav only).
// resolve.collection(row, path), for the lambda operators: a path ending in a collection
// navigation (after single-valued ones) gives { rows, resolve } for the related rows and
// their type; one ending in a collection-valued property gives { values, prop }.
function resolver(svc: QueryHost, entityType: EntityType): Resolve {
  // Follows the single-valued navigations in parts; null when one of them leads nowhere
  const walk = (
    row: Row,
    parts: string[],
    path: string,
  ): { row: Row; type: EntityType } | null => {
    let currentRow = row,
      currentType = entityType;
    for (const part of parts) {
      const nav = svc.navigation(currentType, part);
      if (!nav || nav.isCollection)
        throw new HttpError(400, `Cannot filter on path ${path}`);
      const { rows, type } = svc.related(currentRow, currentType, nav);
      if (rows.length === 0) return null;
      currentRow = rows[0];
      currentType = type;
    }
    return { row: currentRow, type: currentType };
  };
  const resolve = (row: Row, path: string): Literal => {
    // A path that is a property of its own: $apply's result for a groupby on a path
    const own = entityType.properties[path.replace(/^\$it\//, "")];
    if (own) return { value: row[own.name], type: own.type };
    const parts = path.replace(/^\$it\//, "").split("/");
    const at = walk(row, parts.slice(0, -1), path);
    if (!at) return { value: null, type: null };
    const prop = at.type.properties[parts[parts.length - 1]];
    if (!prop)
      throw new HttpError(400, `Unknown property ${path} on ${at.type.name}`);
    return { value: at.row[prop.name], type: prop.type };
  };
  resolve.collection = (row: Row, path: string): Collection => {
    const parts = path.replace(/^\$it\//, "").split("/");
    const last = parts[parts.length - 1];
    const at = walk(row, parts.slice(0, -1), path);
    const type = at?.type;
    const nav = type && svc.navigation(type, last);
    if (at && nav?.isCollection) {
      const related = svc.related(at.row, at.type, nav);
      return { rows: related.rows, resolve: resolver(svc, related.type) };
    }
    const prop = type?.properties[last];
    // A collection-valued property holds an array
    if (at && prop?.isCollection)
      return {
        values: (at.row[prop.name] as PropertyValue[] | null) || [],
        prop,
      };
    if (!at) return { values: [] };
    throw new HttpError(400, `${path} is not a collection: any/all need one`);
  };
  return resolve;
}

// opts: { filter, orderby, top, skip, count, search } (a parsed query or an $expand node).
// aggregate: what $these/aggregate(...) in the filter gives, in a groupby's filter in $apply
function applyQuery(
  svc: QueryHost,
  rows: Row[],
  entityType: EntityType,
  opts: QueryNode,
  aggregate?: Resolve["aggregate"],
): { results: Row[]; count?: number } {
  const resolve = resolver(svc, entityType);
  resolve.aggregate = aggregate;
  let results = rows;

  if (opts.filter) {
    let predicate: (row: Row, resolve: Resolve) => boolean;
    try {
      predicate = compileFilter(opts.filter, svc.protocol);
    } catch (e) {
      throw new HttpError(400, `Invalid $filter: ${(e as Error).message}`);
    }
    try {
      results = results.filter((row) => predicate(row, resolve));
    } catch (e) {
      // Errors found only while evaluating (unknown function, lambda over a
      // non-collection) are 400s too
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `Invalid $filter: ${(e as Error).message}`);
    }
  }

  if (opts.search) {
    // Case-insensitive substring match over every string property; quotes optional.
    const term = opts.search.replace(/^"(.*)"$/, "$1").toLowerCase();
    const stringProps = Object.values(entityType.properties)
      .filter((p) => p.type === "Edm.String")
      .map((p) => p.name);
    results = results.filter((row) =>
      stringProps.some(
        (p) => row[p] !== null && String(row[p]).toLowerCase().includes(term),
      ),
    );
  }

  const count = opts.count ? results.length : undefined;

  if (opts.orderby) {
    const terms = opts.orderby.split(",").map((t) => {
      const [path, dir] = t.trim().split(/\s+/);
      return { path, desc: (dir || "asc").toLowerCase() === "desc" };
    });
    results = [...results].sort((a, b) => {
      for (const { path, desc } of terms) {
        const va = resolve(a, path),
          vb = resolve(b, path);
        const ca = toComparable(va.value, va.type),
          cb = toComparable(vb.value, vb.type);
        let cmp = 0;
        if (ca === null && cb !== null) cmp = -1;
        else if (ca !== null && cb === null) cmp = 1;
        else if (ca !== null && cb !== null) {
          // Both from the same property (see toComparable): numbers, or strings, or
          // booleans, which < orders alike
          const a = ca as number,
            b = cb as number;
          cmp = a < b ? -1 : a > b ? 1 : 0;
        }
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  }

  if (opts.skip !== undefined) results = results.slice(opts.skip);
  if (opts.top !== undefined) results = results.slice(0, opts.top);

  return { results, count };
}

export { applyQuery, resolver };
