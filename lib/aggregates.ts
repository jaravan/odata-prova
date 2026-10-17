// What groupby and aggregate give (see aggregation.ts): the type of their rows, worked out
// before any row is read, and each aggregate's value over a group's rows, decimals added up
// exactly. And the custom aggregates the metadata declares (Aggregation.CustomAggregate).

import { HttpError, own } from "./query.ts";
import { isIntegerType, isNumericType, toComparable } from "./types.ts";
import type {
  Aggregate,
  EntityType,
  Model,
  PrimitiveValue,
  Property,
  Row,
} from "./model.ts";
import type { Qualify, Xml } from "./metadata.ts";

const CUSTOM_AGGREGATE = "Org.OData.Aggregation.V1.CustomAggregate";
const DOUBLE = /^Edm\.(Double|Single)$/;

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
    if (
      own(properties, agg.alias) ||
      (own(type.properties, agg.alias) && !ownName)
    )
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
  if (own(type.customAggregates, name) === undefined)
    throw new HttpError(
      400,
      `$apply: ${name} is not a custom aggregate of ${type.name} (Aggregation.CustomAggregate)`,
    );
  const prop = own(type.properties, name);
  if (!prop)
    throw new HttpError(
      501,
      `$apply: custom aggregate ${name} has no property of its name to aggregate`,
    );
  return prop;
}

function propertyOf(type: EntityType, name: string): Property {
  const prop = own(type.properties, name);
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
    // Every aggregation method leaves out nulls. A path through a collection navigation
    // holds a list of values for each row (see withPaths)
    const values = rows
      .flatMap((r) => {
        const v = r[input.name];
        return input.collectionSegments && Array.isArray(v) ? v : [v];
      })
      .filter((v) => v !== null && v !== undefined) as PrimitiveValue[];
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

export type { Aggregated };
export {
  parseCustomAggregates,
  aggregated,
  aggregateRow,
  resultType,
  unionType,
  propertyOf,
};
