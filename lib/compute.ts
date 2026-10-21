// V4's $compute: properties computed for each row from an expression, written as in $filter,
// that the other query options and the response then treat as the entity's own:
//
//   $compute=NetPrice mul Quantity as LineTotal,year(OrderDate) as Year
//
// The rows get a copy with the values, and their type a copy with a property for each alias,
// typed by its expression (see expressionType in filter.ts), so $filter, $orderby, $select and
// the protocols' serializers need nothing of their own. $apply's compute transformation is
// the same (see aggregation.ts), and so is the expression topcount and the others rank by.

import { compileExpression } from "./filter.ts";
import { HttpError, own, splitTopLevel } from "./query.ts";
import { resolver, type QueryHost } from "./apply-query.ts";
import type {
  Computation,
  EntityType,
  Property,
  PropertyValue,
  Row,
} from "./model.ts";

// "NetPrice mul Quantity as LineTotal,..." -> [{ expression, alias }]. option: the query
// option it's in, for the message of a mistake
function parseCompute(text: string, option = "$compute"): Computation[] {
  return splitTopLevel(text, ",").map((item) => {
    const m = item.match(/^(.+)\s+as\s+(\S+)$/s);
    if (!m) throw new HttpError(400, `Invalid ${option}: ${item}`);
    return { expression: m[1].trim(), alias: m[2] };
  });
}

// The type of a property path: "Prop", or "Nav/Prop" through single-valued navigations. A
// path can also be a property of its own, in a groupby's result (see withPaths in
// aggregation.ts).
function pathType(svc: QueryHost, type: EntityType, path: string): string {
  path = path.replace(/^\$it\//, "");
  const itself = own(type.properties, path);
  if (itself) return itself.type;
  const parts = path.split("/");
  let at = type;
  for (const part of parts.slice(0, -1)) {
    const nav = svc.navigation(at, part);
    if (!nav || nav.isCollection)
      throw new Error(`Cannot compute on path ${path}`);
    at = svc.model.entityTypes[nav.targetType];
  }
  const prop = own(at.properties, parts[parts.length - 1]);
  if (!prop) throw new Error(`Unknown property ${path} on ${at.name}`);
  return prop.type;
}

// A computed value as the store holds a value of its type (see types.ts): Int64 and Decimal
// as text
function stored(value: unknown, type: string): PropertyValue {
  if (value === null || value === undefined) return null;
  if (type === "Edm.Int64" || type === "Edm.Decimal") return String(value);
  return value as PropertyValue;
}

// A mistake in an expression is the client's: a 400. The expression parser is $filter's,
// whose messages name it.
function invalid(e: unknown, option: string): HttpError {
  if (e instanceof HttpError) return e;
  const message = (e as Error).message.replace(/\$filter/g, option);
  return new HttpError(400, `Invalid ${option}: ${message}`);
}

// An expression on the rows of a type: its type, known before any row is read, and its value
// for a row. A mistake in it is a 400 naming the option it's in.
function typedExpression(
  svc: QueryHost,
  type: EntityType,
  text: string,
  option: string,
): { type: string | null; value(row: Row): unknown } {
  try {
    const compiled = compileExpression(text, svc.protocol);
    const resolve = resolver(svc, type);
    return {
      type: compiled.type((path) => pathType(svc, type, path)),
      value(row) {
        try {
          return compiled.evaluate(row, resolve).value;
        } catch (e) {
          throw invalid(e, option);
        }
      },
    };
  } catch (e) {
    throw invalid(e, option);
  }
}

function applyCompute(
  svc: QueryHost,
  rows: readonly Row[],
  type: EntityType,
  compute: Computation[],
  option = "$compute",
): { rows: Row[]; type: EntityType } {
  const properties: Record<string, Property> = {};
  const expressions = compute.map(({ expression, alias }) => {
    // __proto__ would set the rows' prototype rather than a property
    if (!/^[A-Za-z_]\w*$/.test(alias) || alias === "__proto__")
      throw new HttpError(400, `Invalid ${option} alias: ${alias}`);
    if (
      own(type.properties, alias) ||
      own(type.navigations, alias) ||
      own(properties, alias)
    )
      throw new HttpError(
        400,
        `${option}: ${alias} is already a property or navigation of ${type.name}`,
      );
    const typed = typedExpression(svc, type, expression, option);
    if (!typed.type || !/^Edm\.\w+$/.test(typed.type))
      throw new HttpError(
        400,
        `${option}: ${alias} needs a value of a primitive type`,
      );
    properties[alias] = {
      name: alias,
      type: typed.type,
      v2Type: typed.type,
      elementType: typed.type,
      nullable: true,
      sap: {},
      isCollection: false,
      computed: true,
    };
    return { alias, typed };
  });

  const computed = rows.map((row) => {
    const out: Row = { ...row };
    for (const { alias, typed } of expressions)
      out[alias] = stored(typed.value(row), typed.type!);
    return out;
  });
  return {
    rows: computed,
    type: { ...type, properties: { ...type.properties, ...properties } },
  };
}

export { parseCompute, applyCompute, typedExpression };
