// Recursive hierarchies, for UI5's tree tables: the hierarchy functions of V4 $apply (see
// aggregation.ts). A hierarchy is declared on an entity type by two annotations with the same
// qualifier, as CAP writes them for @hierarchy:
//
//   Aggregation.RecursiveHierarchy#GenresHierarchy: the node property (ID) and the
//     navigation to a node's parent (parent)
//   Hierarchy.RecursiveHierarchy#GenresHierarchy: the properties the server fills in for each
//     node it answers with: DrillState, DistanceFromRoot, LimitedDescendantCount, LimitedRank
//
// UI5 asks for the first levels with TopLevels:
//
//   com.sap.vocabularies.Hierarchy.v1.TopLevels(HierarchyNodes=$root/Genres,
//     HierarchyQualifier='GenresHierarchy',NodeProperty='ID',Levels=2,
//     ExpandLevels=[{"NodeID":"4","Levels":1}])
//
// To expand a node, UI5 asks for its children with descendants, and to search or filter, for
// the matching nodes and their ancestors with ancestors, before TopLevels:
//
//   descendants($root/Genres,GenresHierarchy,ID,filter(ID eq 4),1)
//   ancestors($root/Genres,GenresHierarchy,ID,search(Epic),keep start)/TopLevels(...)
//
// The rows a hierarchy function answers with are copies of the entities with those
// properties filled in, and still entities: they keep their key, ETag and navigations.
//
// The Aggregation vocabulary's traverse puts rows in a hierarchy's order, without filling
// anything in: traverse($root/Genres,GenresHierarchy,ID,preorder,Name desc).

import { HttpError, own } from "./query.ts";
import { isIntegerType } from "./types.ts";
import { applyQuery, type QueryHost } from "./apply-query.ts";
import type {
  EntityType,
  Hierarchy,
  Model,
  Row,
  Transformation,
} from "./model.ts";
import type { Qualify, Xml } from "./metadata.ts";

type TopLevels = Extract<Transformation, { kind: "toplevels" }>;
type Relatives = Extract<Transformation, { kind: "ancestors" | "descendants" }>;
type Traverse = Extract<Transformation, { kind: "traverse" }>;

const AGGREGATION_HIERARCHY = "Org.OData.Aggregation.V1.RecursiveHierarchy";
const HIERARCHY_HIERARCHY =
  "com.sap.vocabularies.Hierarchy.v1.RecursiveHierarchy";

// --- Metadata ------------------------------------------------------------------------------

// The parsed XML elements read here: their attributes, and the elements they hold
interface ElementXml {
  Name?: string;
  Namespace?: string;
  Target?: string;
  Term?: string;
  Qualifier?: string;
  Property?: string;
  Path?: string;
  PropertyPath?: string;
  NavigationPropertyPath?: string;
  Annotation?: Xml;
  EntityType?: Xml;
  Annotations?: Xml;
  Record?: Xml;
  PropertyValue?: Xml;
}

// One element or several, as fast-xml-parser gives them
function elements(x: Xml): ElementXml[] {
  if (x === undefined) return [];
  return Array.isArray(x) ? (x as ElementXml[]) : [x as ElementXml];
}

// Sets et.hierarchies from the two annotations, on an entity type, inline or in an
// <Annotations> block targeting it. A Hierarchy.RecursiveHierarchy record names a property
// as LimitedDescendantCount, or as LimitedDescendantCountProperty in older documents.
// schemas are the parsed document's; qualify resolves an alias (see termQualifier in
// metadata.ts).
function parseHierarchies(
  model: Model,
  schemas: Xml[],
  qualify: Qualify,
): void {
  const found: Record<string, Record<string, Record<string, string>>> = {};
  const annotate = (type: EntityType | undefined, xml: Xml) => {
    for (const a of elements(xml)) {
      const term = qualify(a.Term ?? "");
      if (
        !type ||
        !a.Qualifier ||
        (term !== AGGREGATION_HIERARCHY && term !== HIERARCHY_HIERARCHY)
      )
        continue;
      const values = ((found[type.fullName] ??= {})[a.Qualifier] ??= {});
      for (const record of elements(a.Record))
        for (const pv of elements(record.PropertyValue)) {
          const value = pv.PropertyPath ?? pv.NavigationPropertyPath ?? pv.Path;
          if (pv.Property && value)
            values[pv.Property.replace(/Property$/, "")] = value;
        }
    }
  };
  for (const schema of elements(schemas)) {
    for (const et of elements(schema.EntityType))
      annotate(
        model.entityTypes[`${schema.Namespace}.${et.Name}`],
        et.Annotation,
      );
    for (const block of elements(schema.Annotations)) {
      if (String(block.Target).includes("/")) continue;
      annotate(
        model.entityTypes[qualify(String(block.Target))],
        block.Annotation,
      );
    }
  }
  for (const [typeName, byQualifier] of Object.entries(found)) {
    const type = model.entityTypes[typeName];
    for (const [qualifier, v] of Object.entries(byQualifier)) {
      if (!v.Node || !v.ParentNavigation) {
        model.warnings.push(
          `hierarchy ignored: ${type.name}#${qualifier} needs Aggregation.RecursiveHierarchy with NodeProperty and ParentNavigationProperty`,
        );
        continue;
      }
      (type.hierarchies ??= {})[qualifier] = {
        nodeProperty: v.Node,
        parentNavigation: v.ParentNavigation,
        drillState: v.DrillState,
        distanceFromRoot: v.DistanceFromRoot,
        limitedDescendantCount: v.LimitedDescendantCount,
        limitedRank: v.LimitedRank,
      };
    }
  }
}

// --- Parsing -------------------------------------------------------------------------------

// Splits on commas outside parentheses, brackets, braces and quotes (single or double, for
// the JSON of ExpandLevels)
function splitArgs(text: string): string[] {
  const parts: string[] = [];
  let depth = 0,
    quote = "",
    cur = "";
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

// $root/Genres -> Genres
function rootSet(text: string, call: string): string {
  const m = text.match(/^\$root\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!m)
    throw new HttpError(
      501,
      `$apply: ${call}'s hierarchy nodes must be an entity set, $root/<name>: ${text}`,
    );
  return m[1];
}

// The parameters of TopLevels, by name
function parseTopLevels(args: string, text: string): TopLevels {
  const params: Record<string, string> = {};
  for (const part of splitArgs(args)) {
    const eq = part.indexOf("=");
    if (eq < 1) throw new HttpError(400, `Invalid $apply: ${text}`);
    params[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  const quoted = (name: string) => {
    const m = params[name]?.match(/^'(.*)'$/);
    if (!m)
      throw new HttpError(400, `Invalid $apply: TopLevels needs ${name}='...'`);
    return m[1];
  };
  for (const name of Object.keys(params))
    if (
      ![
        "HierarchyNodes",
        "HierarchyQualifier",
        "NodeProperty",
        "Levels",
        "ExpandLevels",
        "Show",
      ].includes(name)
    )
      throw new HttpError(
        400,
        `$apply: TopLevels's ${name} is not a parameter`,
      );
  if (!params.HierarchyNodes)
    throw new HttpError(400, `Invalid $apply: TopLevels needs HierarchyNodes`);
  let levels: number | undefined;
  if (params.Levels !== undefined) {
    if (!/^\d+$/.test(params.Levels) || params.Levels === "0")
      throw new HttpError(400, `Invalid $apply: Levels=${params.Levels}`);
    levels = Number(params.Levels);
  }
  return {
    kind: "toplevels",
    set: rootSet(params.HierarchyNodes, "TopLevels"),
    qualifier: quoted("HierarchyQualifier"),
    nodeProperty: quoted("NodeProperty"),
    levels,
    expandLevels: parseExpandLevels(params.ExpandLevels),
    show: parseShow(params.Show),
  };
}

// ["4","7"]: the node IDs to show
function parseShow(text: string | undefined): string[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, `Invalid $apply: Show=${text}`);
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string"))
    throw new HttpError(400, `Invalid $apply: Show=${text}`);
  return parsed as string[];
}

// traverse(H,Q,p,preorder|postorder[,orderby...]): the hierarchy nodes ($root/Genres), its
// qualifier, the node property, the order, and how to sort roots and siblings
function parseTraverse(args: string, text: string): Traverse {
  const [nodes, qualifier, nodeProperty, order, ...orderby] = splitArgs(args);
  if (
    !order ||
    !/^[A-Za-z_]\w*$/.test(qualifier) ||
    (order !== "preorder" && order !== "postorder")
  )
    throw new HttpError(400, `Invalid $apply: ${text}`);
  return {
    kind: "traverse",
    set: rootSet(nodes, "traverse"),
    qualifier,
    nodeProperty,
    order,
    orderby: orderby.length ? orderby.join(",") : undefined,
  };
}

// ancestors(H,Q,p,T[,d][,keep start]): the hierarchy nodes ($root/Genres), its qualifier,
// the node property, the transformations that give the start nodes, the greatest distance
// (1 or more), and whether the start nodes are kept
function parseRelatives(
  kind: Relatives["kind"],
  args: string,
  text: string,
  parseApply: (text: string) => Transformation[],
): Relatives {
  const [nodes, qualifier, nodeProperty, transformations, ...rest] =
    splitArgs(args);
  if (!transformations || !/^[A-Za-z_]\w*$/.test(qualifier))
    throw new HttpError(400, `Invalid $apply: ${text}`);
  let distance: number | undefined;
  let keepStart = false;
  for (const option of rest) {
    if (option === "keep start" && !keepStart) keepStart = true;
    else if (/^\d+$/.test(option) && Number(option) >= 1 && !distance)
      distance = Number(option);
    else throw new HttpError(400, `Invalid $apply: ${text}`);
  }
  return {
    kind,
    set: rootSet(nodes, kind),
    qualifier,
    nodeProperty,
    transformations: parseApply(transformations),
    distance,
    keepStart,
  };
}

// [{"NodeID":"4","Levels":1}]: Levels is a number, 0 to collapse, or null for all
function parseExpandLevels(
  text: string | undefined,
): TopLevels["expandLevels"] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, `Invalid $apply: ExpandLevels=${text}`);
  }
  if (!Array.isArray(parsed))
    throw new HttpError(400, `Invalid $apply: ExpandLevels=${text}`);
  return parsed.map((e: { NodeID?: unknown; Levels?: unknown }) => {
    const levels = e?.Levels ?? null;
    if (
      typeof e?.NodeID !== "string" ||
      (levels !== null && !(Number.isInteger(levels) && Number(levels) >= 0))
    )
      throw new HttpError(400, `Invalid $apply: ExpandLevels=${text}`);
    return { nodeId: e.NodeID, levels: levels as number | null };
  });
}

// --- Running -------------------------------------------------------------------------------

// The rows the hierarchy functions answer with: copies of entities, which are entities too
// (see entities in service.ts)
const hierarchyRows = new WeakSet<Row>();

function isHierarchyRow(row: Row): boolean {
  return hierarchyRows.has(row);
}

// The hierarchy a function names, checked against the type and the set it runs on
function hierarchyOf(
  svc: QueryHost,
  type: EntityType,
  t: { set: string; qualifier: string; nodeProperty: string },
): Hierarchy {
  const es = own(svc.model.entitySets, t.set);
  if (!es || es.entityType !== type.fullName)
    throw new HttpError(
      400,
      `$apply: ${t.set} is not an entity set of ${type.name}`,
    );
  const h = own(type.hierarchies, t.qualifier);
  if (!h)
    throw new HttpError(
      400,
      `$apply: ${t.qualifier} is not a recursive hierarchy of ${type.name} (Aggregation.RecursiveHierarchy)`,
    );
  if (h.nodeProperty !== t.nodeProperty)
    throw new HttpError(
      400,
      `$apply: ${t.qualifier}'s node property is ${h.nodeProperty}, not ${t.nodeProperty}`,
    );
  if (!svc.navigation(type, h.parentNavigation))
    throw new HttpError(
      400,
      `$apply: ${t.qualifier}'s parent navigation ${h.parentNavigation} is not a navigation of ${type.name}`,
    );
  return h;
}

// The rows as a forest: each node's children in the rows' order, and the roots, which are
// the rows whose parent isn't among them. Node IDs are compared as text, as ExpandLevels
// gives them. Parents that go round in a cycle, as generated mock data can have them, would
// leave nodes no root leads to: the first of them in the rows' order is made a root.
interface Forest {
  roots: Row[];
  children: Map<Row, Row[]>;
  byId: Map<string, Row>;
  parentOf: Map<Row, Row>;
}

function forestOf(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  h: Hierarchy,
): Forest {
  const nav = svc.navigation(type, h.parentNavigation)!;
  const byId = new Map(rows.map((r) => [String(r[h.nodeProperty]), r]));
  const roots: Row[] = [];
  const children = new Map<Row, Row[]>(rows.map((r) => [r, []]));
  const parentOf = new Map<Row, Row>();
  for (const row of rows) {
    const parent = svc.related(row, type, nav).rows[0];
    const inRows = parent && byId.get(String(parent[h.nodeProperty]));
    if (inRows && inRows !== row) {
      children.get(inRows)!.push(row);
      parentOf.set(row, inRows);
    } else roots.push(row);
  }
  const reached = new Set<Row>();
  const reach = (node: Row) => {
    reached.add(node);
    for (const kid of children.get(node)!) reach(kid);
  };
  roots.forEach(reach);
  for (const row of rows)
    if (!reached.has(row)) {
      const siblings = children.get(parentOf.get(row)!)!;
      siblings.splice(siblings.indexOf(row), 1);
      roots.push(row);
      reach(row);
    }
  // Roots in the rows' order, those that broke a cycle included
  const index = new Map(rows.map((r, i) => [r, i]));
  roots.sort((a, b) => index.get(a)! - index.get(b)!);
  for (const root of roots) parentOf.delete(root);
  return { roots, children, byId, parentOf };
}

// TopLevels: the nodes with fewer ancestors than Levels (all without Levels), in preorder,
// where ExpandLevels shows more levels below a node or collapses it, and Show expands every
// ancestor of a node (even one ExpandLevels collapses), so that it's shown too. A node ID
// that isn't among the rows is left alone.
function topLevels(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  t: TopLevels,
): Row[] {
  const h = hierarchyOf(svc, type, t);
  const forest = forestOf(svc, rows, type, h);
  const expand = new Map(t.expandLevels.map((e) => [e.nodeId, e.levels]));
  const opened = new Set<Row>();
  for (const id of t.show)
    for (
      let at = forest.parentOf.get(forest.byId.get(id)!);
      at && !opened.has(at);
      at = forest.parentOf.get(at)
    )
      opened.add(at);
  const limited: Limited = { order: [], shown: new Map(), depth: new Map() };
  // below: how many levels to show under the node
  const visit = (node: Row, below: number, depth: number) => {
    limited.order.push(node);
    limited.depth.set(node, depth);
    const override = expand.get(String(node[h.nodeProperty]));
    if (override !== undefined) below = override ?? Infinity;
    if (opened.has(node)) below = Math.max(below, 1);
    const kids = below > 0 ? forest.children.get(node)! : [];
    limited.shown.set(node, kids);
    for (const kid of kids) visit(kid, below - 1, depth + 1);
  };
  const levels = t.levels ?? Infinity;
  for (const root of forest.roots) visit(root, levels - 1, 0);
  return withDerived(type, h, limited, forest);
}

// ancestors and descendants: the rows that are, in the whole hierarchy, ancestors or
// descendants of the start nodes (within the distance), in the rows' order, with the start
// nodes among them when keepStart. run gives the start nodes: the transformations applied to
// the rows.
function relatives(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  t: Relatives,
  run: (
    rows: readonly Row[],
    transformations: Transformation[],
  ) => { rows: readonly Row[] },
): Row[] {
  const h = hierarchyOf(svc, type, t);
  const id = (row: Row) => String(row[h.nodeProperty]);
  const start = new Set(run(rows, t.transformations).rows.map(id));
  // Each node's parent in the whole hierarchy
  const nav = svc.navigation(type, h.parentNavigation)!;
  const parentOf = new Map<string, string>();
  for (const row of svc.store.rows(t.set)) {
    const parent = svc.related(row, type, nav).rows[0];
    if (parent) parentOf.set(id(row), id(parent));
  }
  // A node's ancestors, nearest first, up to the distance; a cycle ends the walk
  const ancestors = (node: string): string[] => {
    const found: string[] = [];
    for (
      let at = parentOf.get(node);
      at !== undefined && !found.includes(at) && at !== node;
      at = parentOf.get(at)
    ) {
      if (found.length === (t.distance ?? Infinity)) break;
      found.push(at);
    }
    return found;
  };
  const keep =
    t.kind === "ancestors"
      ? (() => {
          const wanted = new Set([...start].flatMap(ancestors));
          return (node: string) => wanted.has(node);
        })()
      : (node: string) => ancestors(node).some((a) => start.has(a));
  const result = rows.filter(
    (row) => keep(id(row)) || (t.keepStart && start.has(id(row))),
  );
  // Filled in relative to the result, with the rows as the whole hierarchy
  const forest = forestOf(svc, rows, type, h);
  const inResult = new Set(result);
  const depth = new Map<Row, number>();
  const measure = (node: Row, d: number) => {
    depth.set(node, d);
    for (const kid of forest.children.get(node)!) measure(kid, d + 1);
  };
  forest.roots.forEach((r) => measure(r, 0));
  const shown = new Map(
    result.map((node) => [
      node,
      forest.children.get(node)!.filter((kid) => inResult.has(kid)),
    ]),
  );
  return withDerived(type, h, { order: result, shown, depth }, forest);
}

// The nodes a hierarchy function answers with (the limited hierarchy): in order, the
// children shown under each, and how many ancestors each has among them
interface Limited {
  order: Row[];
  shown: Map<Row, Row[]>;
  depth: Map<Row, number>;
}

// Copies of the nodes in order, with the properties the hierarchy names filled in, relative to
// the nodes shown (the limited hierarchy) and to the whole forest
function withDerived(
  type: EntityType,
  h: Hierarchy,
  limited: Limited,
  forest: Forest,
): Row[] {
  const { order, shown, depth } = limited;
  const counts = new Map<Row, number>();
  const descendants = (node: Row): number => {
    let n = counts.get(node);
    if (n === undefined) {
      n = (shown.get(node) ?? []).reduce(
        (s, kid) => s + 1 + descendants(kid),
        0,
      );
      counts.set(node, n);
    }
    return n;
  };
  return order.map((node, rank) => {
    const out: Row = { ...node };
    const set = (name: string | undefined, value: number | string) => {
      if (!name) return;
      const prop = type.properties[name];
      // An Int64 holds text (see toInternal), a smaller integer a number
      out[name] =
        typeof value === "number" && prop && !isIntegerType(prop.type)
          ? String(value)
          : value;
    };
    set(
      h.drillState,
      (shown.get(node) ?? []).length
        ? "expanded"
        : forest.children.get(node)?.length
          ? "collapsed"
          : "leaf",
    );
    set(h.distanceFromRoot, depth.get(node)!);
    set(h.limitedDescendantCount, descendants(node));
    set(h.limitedRank, rank);
    hierarchyRows.add(out);
    return out;
  });
}

// traverse: the rows in the order of the whole hierarchy, sorted by orderby first when given,
// so that a node keeps its place when the rows leave out its parent. The rows themselves,
// nothing filled in.
function traverse(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  t: Traverse,
): Row[] {
  const h = hierarchyOf(svc, type, t);
  let nodes = svc.store.rows(t.set);
  if (t.orderby)
    nodes = applyQuery(svc, nodes, type, {
      expand: {},
      orderby: t.orderby,
    }).results;
  const forest = forestOf(svc, nodes, type, h);
  const id = (row: Row) => String(row[h.nodeProperty]);
  const input = new Map<string, Row[]>();
  for (const row of rows) {
    const same = input.get(id(row));
    if (same) same.push(row);
    else input.set(id(row), [row]);
  }
  const out: Row[] = [];
  const visit = (node: Row) => {
    const own = input.get(id(node)) ?? [];
    input.delete(id(node));
    if (t.order === "preorder") out.push(...own);
    forest.children.get(node)!.forEach(visit);
    if (t.order === "postorder") out.push(...own);
  };
  forest.roots.forEach(visit);
  // Rows that aren't nodes of the hierarchy, in their order
  for (const left of input.values()) out.push(...left);
  return out;
}

export {
  parseHierarchies,
  parseTopLevels,
  parseRelatives,
  parseTraverse,
  topLevels,
  relatives,
  traverse,
  isHierarchyRow,
};
