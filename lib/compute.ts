// V4's $compute: properties computed for each row from an expression, written as in $filter,
// that the other query options and the response then treat as the entity's own:
//
//   $compute=NetPrice mul Quantity as LineTotal,year(OrderDate) as Year
//
// The rows get a copy with the values, and their type a copy with a property for each alias,
// typed by its expression (see expressionType in filter.ts), so $filter, $orderby, $select and
// the protocols' serializers need nothing of their own.

import { compileExpression } from "./filter.ts";
import { HttpError, splitTopLevel } from "./query.ts";
import { resolver, type QueryHost } from "./apply-query.ts";
import type {
  Computation,
  EntityType,
  Property,
  PropertyValue,
  Row,
} from "./model.ts";

// "NetPrice mul Quantity as LineTotal,..." -> [{ expression, alias }]
function parseCompute(text: string): Computation[] {
  return splitTopLevel(text, ",").map((item) => {
    const m = item.match(/^(.+)\s+as\s+(\S+)$/s);
    if (!m) throw new HttpError(400, `Invalid $compute: ${item}`);
    return { expression: m[1].trim(), alias: m[2] };
  });
}

// The type of a property path: "Prop", or "Nav/Prop" through single-valued navigations
function pathType(svc: QueryHost, type: EntityType, path: string): string {
  const parts = path.replace(/^\$it\//, "").split("/");
  let at = type;
  for (const part of parts.slice(0, -1)) {
    const nav = svc.navigation(at, part);
    if (!nav || nav.isCollection)
      throw new Error(`Cannot compute on path ${path}`);
    at = svc.model.entityTypes[nav.targetType];
  }
  const prop = at.properties[parts[parts.length - 1]];
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
function invalid(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const message = (e as Error).message.replace(/\$filter/g, "$compute");
  return new HttpError(400, `Invalid $compute: ${message}`);
}

function applyCompute(
  svc: QueryHost,
  rows: Row[],
  type: EntityType,
  compute: Computation[],
): { rows: Row[]; type: EntityType } {
  const properties: Record<string, Property> = {};
  const expressions = compute.map(({ expression, alias }) => {
    if (!/^[A-Za-z_]\w*$/.test(alias))
      throw new HttpError(400, `Invalid $compute alias: ${alias}`);
    if (type.properties[alias] || type.navigations[alias] || properties[alias])
      throw new HttpError(
        400,
        `$compute: ${alias} is already a property or navigation of ${type.name}`,
      );
    let compiled: ReturnType<typeof compileExpression>;
    let result: string | null;
    try {
      compiled = compileExpression(expression, svc.protocol);
      result = compiled.type((path) => pathType(svc, type, path));
    } catch (e) {
      throw invalid(e);
    }
    if (!result || !/^Edm\.\w+$/.test(result))
      throw new HttpError(
        400,
        `$compute: ${alias} needs a value of a primitive type`,
      );
    properties[alias] = {
      name: alias,
      type: result,
      v2Type: result,
      elementType: result,
      nullable: true,
      sap: {},
      isCollection: false,
      computed: true,
    };
    return { alias, compiled, type: result };
  });

  const resolve = resolver(svc, type);
  const computed = rows.map((row) => {
    const out: Row = { ...row };
    for (const { alias, compiled, type } of expressions) {
      try {
        out[alias] = stored(compiled.evaluate(row, resolve).value, type);
      } catch (e) {
        throw invalid(e);
      }
    }
    return out;
  });
  return {
    rows: computed,
    type: { ...type, properties: { ...type.properties, ...properties } },
  };
}

export { parseCompute, applyCompute };
