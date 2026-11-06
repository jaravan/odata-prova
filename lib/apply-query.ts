// Applies a request's query options to rows: $filter, $search, $count, $orderby, $skip and
// $top, for a collection or an $expand node.

import { compareValues, toComparable } from "./types.ts";
import { ROW_READ, sortWork, spend } from "./work.ts";
import { compileFilter, scopeOf } from "./filter.ts";
import { search } from "./search.ts";
import type {
  Collection,
  LiteralSyntax,
  PathScope,
  Resolve,
} from "./filter.ts";
import { HttpError, own } from "./query.ts";
import type {
  AnyNavigation,
  EntityType,
  Literal,
  Model,
  Property,
  PropertyValue,
  QueryNode,
  Row,
} from "./model.ts";

// What the query options use of the service (the ODataService in service.ts)
export interface QueryHost {
  model: Model;
  // An entity set's rows, which a hierarchy's nodes are (see hierarchy.ts)
  store: { rows(setName: string): readonly Row[] };
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
  // V4 writes a time to its Precision, so that's as fine as a client can ask for it. V2 writes
  // it to the millisecond, whatever the Precision.
  const valueOf = (row: Row, prop: Property): Literal =>
    svc.protocol.version === "4.0" &&
    ["Edm.DateTimeOffset", "Edm.TimeOfDay"].includes(prop.type)
      ? {
          value: row[prop.name],
          type: prop.type,
          fraction: prop.precision ?? "0",
        }
      : { value: row[prop.name], type: prop.type };
  const resolve = (row: Row, path: string): Literal => {
    // A path that is a property of its own: $apply's result for a groupby on a path
    const itself = own(entityType.properties, path.replace(/^\$it\//, ""));
    if (itself) return valueOf(row, itself);
    const parts = path.replace(/^\$it\//, "").split("/");
    const at = walk(row, parts.slice(0, -1), path);
    if (!at) return { value: null, type: null };
    const prop = own(at.type.properties, parts[parts.length - 1]);
    if (!prop)
      throw new HttpError(400, `Unknown property ${path} on ${at.type.name}`);
    return valueOf(at.row, prop);
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
    const prop = own(type?.properties, last);
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

// Checks paths against a type alone, as resolver reads them from a row: a mistake is a 400
// whatever rows there are.
function pathScope(svc: QueryHost, entityType: EntityType): PathScope {
  // Where the single-valued navigations in parts lead
  const walk = (parts: string[], path: string): EntityType => {
    let at = entityType;
    for (const part of parts) {
      const nav = svc.navigation(at, part);
      if (!nav || nav.isCollection)
        throw new HttpError(400, `Cannot filter on path ${path}`);
      at = svc.model.entityTypes[nav.targetType];
    }
    return at;
  };
  return {
    check(path) {
      const name = path.replace(/^\$it\//, "");
      if (own(entityType.properties, name)) return;
      const parts = name.split("/");
      const at = walk(parts.slice(0, -1), path);
      if (!own(at.properties, parts[parts.length - 1]))
        throw new HttpError(400, `Unknown property ${path} on ${at.name}`);
    },
    collection(path) {
      const parts = path.split("/");
      const last = parts[parts.length - 1];
      const at = walk(parts.slice(0, -1), path);
      const nav = svc.navigation(at, last);
      if (nav?.isCollection)
        return pathScope(svc, svc.model.entityTypes[nav.targetType]);
      if (own(at.properties, last)?.isCollection) return undefined;
      throw new HttpError(400, `${path} is not a collection: any/all need one`);
    },
  };
}

// opts: { filter, orderby, top, skip, count, search } (a parsed query or an $expand node).
// aggregate: what $these/aggregate(...) in the filter gives, in a groupby's filter in $apply
function applyQuery(
  svc: QueryHost,
  rows: readonly Row[],
  entityType: EntityType,
  opts: QueryNode,
  aggregate?: Resolve["aggregate"],
): { results: readonly Row[]; count?: number } {
  const resolve = resolver(svc, entityType);
  resolve.aggregate = aggregate;
  let results = rows;

  if (opts.filter) {
    let predicate: (row: Row, resolve: Resolve) => boolean;
    try {
      predicate = compileFilter(
        opts.filter,
        svc.protocol,
        scopeOf(svc.model, entityType),
        pathScope(svc, entityType),
      );
    } catch (e) {
      if (e instanceof HttpError) throw e;
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

  // An empty one (a cleared search field) searches for nothing, and finds everything
  if (opts.search?.trim()) {
    // Terms matched in any case, in any string property (see search.ts)
    const stringProps = Object.values(entityType.properties)
      .filter((p) => p.type === "Edm.String")
      .map((p) => p.name);
    spend(results.length * Math.max(stringProps.length, 1) * ROW_READ);
    results = search(results, opts.search, stringProps);
  }

  const count = opts.count ? results.length : undefined;

  if (opts.orderby) {
    const terms = opts.orderby.split(",").map((t) => {
      const [path, dir = "asc", ...more] = t.trim().split(/\s+/);
      // Anything else after the path would be left out, and sort by something else
      if (more.length || !/^(?:asc|desc)$/i.test(dir))
        throw new HttpError(
          400,
          `Invalid $orderby: ${t.trim()} (write a property, then asc or desc)`,
        );
      pathScope(svc, entityType).check(path);
      return { path, desc: dir.toLowerCase() === "desc" };
    });
    spend(sortWork(results.length, terms.length));
    results = [...results].sort((a, b) => {
      for (const { path, desc } of terms) {
        const va = resolve(a, path),
          vb = resolve(b, path);
        const ca = toComparable(va.value, va.type),
          cb = toComparable(vb.value, vb.type);
        let cmp = 0;
        if (ca === null && cb !== null) cmp = -1;
        else if (ca !== null && cb === null) cmp = 1;
        // Both from the same property (see toComparable): numbers, or strings, or
        // booleans, which < orders alike
        else if (ca !== null && cb !== null) cmp = compareValues(ca, cb);
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
