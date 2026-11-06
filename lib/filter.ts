// Everything for parsing and running $filter is here: tokenizer, recursive-descent
// parser, and an evaluator that turns the AST into (row, resolve) => boolean.
// V2 and V4 share this whole pipeline - the only real difference is how literals are
// spelled on the wire (V2 wants datetime'...', guid'...', 12L; V4 just writes
// 2025-01-20 or a bare GUID), so that's the one bit each protocol module has to supply.
//
// Precedence goes or < and < not < comparison (eq/ne/gt/ge/lt/le/in) < add/sub < mul/div/mod
// < unary minus < primary (literal, property path, function call, parens) - standard hierarchy.

import type {
  EntityType,
  Literal,
  Model,
  PrimitiveValue,
  Property,
  PropertyValue,
  Row,
} from "./model.ts";
import { HttpError, own } from "./query.ts";
import {
  DECIMAL_DIGITS,
  INT64,
  decimalText,
  decimalUnits,
  inIntegerRange,
  enumNamed,
  enumValue,
  isNumericType,
  toComparable,
  enumNumber,
  isNumberText,
  toMillis,
  withPrecision,
} from "./types.ts";
import { spend } from "./work.ts";

// What a protocol module supplies: how its literals are spelled
export interface LiteralSyntax {
  version?: string;
  typedLiteralPrefixes: Set<string>;
  parseLiteral(text: string): Literal;
  // V4 only: GUIDs, dates and times written without a prefix
  matchBareLiteral?(text: string): (Literal & { length: number }) | undefined;
}

// A value while evaluating: a property's or a literal's, with its Edm type
type Value = Literal;

// What the paths of an expression are checked against: a type's (see pathScope in
// apply-query.ts). collection gives the scope of a collection's items, undefined when they're
// a collection property's.
export interface PathScope {
  // The path's type, or an error when there's no such path
  check(path: string): string;
  collection(path: string): PathScope | undefined;
}

// Reads a property path off a row (the caller knows the entity type and how to follow a
// navigation); .collection reads a path that ends in a collection, for the lambda operators;
// .aggregate gives $these/aggregate(<expression>), the aggregate over the rows being
// filtered, which only a groupby's filter in $apply has (see aggregation.ts)
export interface Resolve {
  (row: Row, path: string): Value;
  collection(row: Row, path: string): Collection;
  aggregate?: (expression: string) => Value;
}

// The related rows of a collection navigation, or the items of a collection-valued property
export type Collection =
  | { rows: Row[]; resolve: Resolve }
  | { values: PropertyValue[]; prop?: Property };

type Token =
  | { kind: "(" | ")" | "," | ":" }
  | ({ kind: "literal" } & Literal)
  | { kind: "op"; value: string }
  | { kind: "func"; value: string }
  | { kind: "path"; value: string }
  | { kind: "lambda"; path: string; value: string }
  // $these/aggregate(Amount with sum): the expression between the parentheses
  | { kind: "these"; value: string };

type Node =
  | { literal: unknown; type: string | null }
  | { path: string }
  | { op: string; left: Node; right: Node }
  | { in: true; left: Node; list: Node[] }
  | { not: true; expr: Node }
  | { neg: true; expr: Node }
  | { func: string; args: Node[] }
  | { lambda: string; path: string; variable?: string; predicate?: Node }
  | { these: string };

const KEYWORDS = new Set([
  "eq",
  "ne",
  "gt",
  "ge",
  "lt",
  "le",
  "in",
  "has",
  "and",
  "or",
  "not",
  "add",
  "sub",
  "mul",
  "div",
  "divby",
  "mod",
]);

// What a word is, where a value can be, whatever a property is called. These four are always
// the keyword, as the spec writes them.
const RESERVED = new Set(["true", "false", "null", "not"]);

// What an expression needs of the model. isProperty: whether the type being filtered has a
// property of that name, so that Div eq 5 and True eq true read the property. Where an
// operator can be it's the operator, so that Add add 1 reads each as it should. enumMember:
// the member an enum's literal names, a mistake in which is a 400 rather than no rows.
interface Scope {
  isProperty(name: string): boolean;
  enumMember(literal: Literal): string;
}

function scopeOf(model: Model, type: EntityType): Scope {
  return {
    isProperty: (name) => Object.hasOwn(type.properties, name),
    enumMember({ enumType, value }) {
      const named = enumNamed(model, enumType!);
      if (!named) throw new Error(`${enumType} is not an enum type`);
      return enumValue(value, named);
    },
  };
}

function tokenize(
  input: string,
  protocol: LiteralSyntax,
  scope?: Scope,
): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // ":" separates a lambda variable from its predicate: Items/any(i:i/Material eq 'X')
    if (c === "(" || c === ")" || c === "," || c === ":") {
      tokens.push({ kind: c });
      i++;
      continue;
    }
    if (c === "'") {
      // Quotes escape by doubling up, e.g. 'it''s' means it's - no backslashes in OData strings.
      let j = i + 1;
      let out = "";
      for (;;) {
        if (j >= input.length)
          throw new Error("Unterminated string literal in $filter");
        if (input[j] === "'") {
          if (input[j + 1] === "'") {
            out += "'";
            j += 2;
            continue;
          }
          break;
        }
        out += input[j++];
      }
      tokens.push({ kind: "literal", value: out, type: "Edm.String" });
      i = j + 1;
      continue;
    }
    // Check bare V4 literals (GUIDs, dates/times) before the word and number cases below -
    // they can start with a letter or a digit, so they'd get misread as one of those otherwise.
    const bare = protocol.matchBareLiteral
      ? protocol.matchBareLiteral(input.slice(i))
      : undefined;
    if (bare) {
      tokens.push({ kind: "literal", value: bare.value, type: bare.type });
      i += bare.length;
      continue;
    }
    // From here on it's a bare word - could be a typed literal (datetime'...', guid'...'),
    // a keyword, true/false/null, a function name, a lambda (Items/any), or a property path
    // ($it/Prop: the outer entity).
    const word = input
      .slice(i)
      .match(/^\$?[\p{L}_][\p{L}\p{M}\p{N}_./]*(?:(?<=\/)\$count\b)?/u);
    if (word) {
      const w = word[0];
      // An aggregate expression isn't a filter expression ("Amount with sum"), so its text
      // is kept as it is, up to the closing parenthesis
      if (w === "$these/aggregate" && input[i + w.length] === "(") {
        const start = i + w.length + 1;
        let end = start;
        for (let depth = 1; ; end++) {
          if (end >= input.length)
            throw new Error("Unterminated $these/aggregate( in $filter");
          if (input[end] === "(") depth++;
          else if (input[end] === ")" && --depth === 0) break;
        }
        tokens.push({ kind: "these", value: input.slice(start, end).trim() });
        i = end + 1;
        continue;
      }
      const lambda = w.match(/^(.+)\/(any|all)$/);
      if (lambda && input[i + w.length] === "(") {
        tokens.push({ kind: "lambda", path: lambda[1], value: lambda[2] });
        i += w.length;
        continue;
      }
      if (
        input[i + w.length] === "'" &&
        protocol.typedLiteralPrefixes.has(w.toLowerCase())
      ) {
        const end = input.indexOf("'", i + w.length + 1);
        if (end === -1)
          throw new Error("Unterminated typed literal in $filter");
        const text = input.slice(i, end + 1);
        tokens.push({ kind: "literal", ...protocol.parseLiteral(text) });
        i = end + 1;
        continue;
      }
      // An enum's literal, by its type's qualified name: Sales.Color'Red'
      if (w.includes(".") && input[i + w.length] === "'") {
        let end = input.indexOf("'", i + w.length + 1);
        while (end !== -1 && input[end + 1] === "'")
          end = input.indexOf("'", end + 2);
        if (end === -1)
          throw new Error("Unterminated typed literal in $filter");
        const literal = protocol.parseLiteral(input.slice(i, end + 1));
        tokens.push({
          kind: "literal",
          ...literal,
          value: scope ? scope.enumMember(literal) : literal.value,
        });
        i = end + 1;
        continue;
      }
      const lower = w.toLowerCase();
      const previous = tokens.at(-1)?.kind;
      const operandHere =
        previous !== "literal" &&
        previous !== "path" &&
        previous !== ")" &&
        previous !== "these";
      if (
        operandHere &&
        !RESERVED.has(w) &&
        input[i + w.length] !== "(" &&
        scope?.isProperty(w)
      )
        tokens.push({ kind: "path", value: w });
      else if (KEYWORDS.has(lower)) tokens.push({ kind: "op", value: lower });
      else if (lower === "true" || lower === "false")
        tokens.push({
          kind: "literal",
          value: lower === "true",
          type: "Edm.Boolean",
        });
      else if (lower === "null")
        tokens.push({ kind: "literal", value: null, type: null });
      else if (input[i + w.length] === "(")
        tokens.push({ kind: "func", value: lower });
      else tokens.push({ kind: "path", value: w });
      i += w.length;
      continue;
    }
    const num = input
      .slice(i)
      .match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?[lLmMdDfF]?/);
    if (num) {
      tokens.push({ kind: "literal", ...protocol.parseLiteral(num[0]) });
      i += num[0].length;
      continue;
    }
    // A minus that doesn't start a number negates what follows: -Price, -(a add b). OData
    // subtracts with sub, so a minus is never binary.
    if (c === "-") {
      tokens.push({ kind: "op", value: "-" });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${c}' in $filter at position ${i}`);
  }
  return tokens;
}

// The parser hands back one of: {literal, type}, {path}, {op, left, right}, {in, left, list},
// {not, expr}, {neg, expr}, {func, args}, {lambda, path, variable, predicate}
// (variable and predicate absent for Items/any()), or {these} ($these/aggregate(...)).
// Nothing fancy, just plain objects.
class Parser {
  tokens: Token[];
  pos: number;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token | undefined {
    return this.tokens[this.pos++];
  }
  isOp(...values: string[]): boolean {
    const t = this.peek();
    return t !== undefined && t.kind === "op" && values.includes(t.value);
  }
  expect<K extends Token["kind"]>(kind: K): Extract<Token, { kind: K }> {
    const t = this.next();
    if (!t || t.kind !== kind) throw new Error(`Expected ${kind} in $filter`);
    return t as Extract<Token, { kind: K }>;
  }

  parse(): Node {
    const expr = this.parseOr();
    if (this.pos < this.tokens.length)
      throw new Error("Unexpected trailing input in $filter");
    return expr;
  }
  parseOr(): Node {
    let left = this.parseAnd();
    while (this.isOp("or")) {
      this.next();
      left = { op: "or", left, right: this.parseAnd() };
    }
    return left;
  }
  parseAnd(): Node {
    let left = this.parseNot();
    while (this.isOp("and")) {
      this.next();
      left = { op: "and", left, right: this.parseNot() };
    }
    return left;
  }
  parseNot(): Node {
    if (this.isOp("not")) {
      this.next();
      return { not: true, expr: this.parseNot() };
    }
    return this.parseComparison();
  }
  parseComparison(): Node {
    let left: Node = this.parseAdditive();
    for (;;) {
      if (this.isOp("in")) {
        this.next();
        this.expect("(");
        const list: Node[] = [];
        if (this.peek() && this.peek()?.kind !== ")") {
          list.push(this.parseAdditive());
          while (this.peek() && this.peek()?.kind === ",") {
            this.next();
            list.push(this.parseAdditive());
          }
        }
        this.expect(")");
        left = { in: true, left, list };
      } else if (this.isOp("eq", "ne", "gt", "ge", "lt", "le", "has")) {
        const op = this.expect("op").value;
        left = { op, left, right: this.parseAdditive() };
      } else {
        return left;
      }
    }
  }
  parseAdditive(): Node {
    let left = this.parseMultiplicative();
    while (this.isOp("add", "sub")) {
      const op = this.expect("op").value;
      left = { op, left, right: this.parseMultiplicative() };
    }
    return left;
  }
  parseMultiplicative(): Node {
    let left = this.parseUnary();
    while (this.isOp("mul", "div", "divby", "mod")) {
      const op = this.expect("op").value;
      left = { op, left, right: this.parseUnary() };
    }
    return left;
  }
  parseUnary(): Node {
    const t = this.peek();
    // -Price, as the spec writes it; sub Price as well, as it always worked
    if (t && t.kind === "op" && (t.value === "-" || t.value === "sub")) {
      this.next();
      return { neg: true, expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }
  parsePrimary(): Node {
    const t = this.next();
    if (!t) throw new Error("Unexpected end of $filter");
    if (t.kind === "(") {
      const e = this.parseOr();
      this.expect(")");
      return e;
    }
    if (t.kind === "literal") return { literal: t.value, type: t.type };
    if (t.kind === "path") return { path: t.value };
    if (t.kind === "these") return { these: t.value };
    if (t.kind === "lambda") {
      this.expect("(");
      if (this.peek()?.kind === ")") {
        this.next();
        if (t.value === "all")
          throw new Error("all() needs a predicate in $filter");
        return { lambda: t.value, path: t.path };
      }
      const variable = this.expect("path").value;
      if (variable.includes("/"))
        throw new Error(`Invalid lambda variable ${variable} in $filter`);
      this.expect(":");
      const predicate = this.parseOr();
      this.expect(")");
      return { lambda: t.value, path: t.path, variable, predicate };
    }
    if (t.kind === "func") {
      // Before its arguments, which for cast and isof name a type, not a property: a
      // function of the spec's the server doesn't have is a 501, any other name a 400
      if (!own(FUNCTION_TYPES, t.value) && !ROUNDING.includes(t.value)) {
        if (UNSUPPORTED_FUNCTIONS.includes(t.value))
          throw new HttpError(
            501,
            `The $filter function ${t.value} is not supported`,
          );
        throw new Error(`Unsupported $filter function ${t.value}`);
      }
      this.expect("(");
      const args: Node[] = [];
      if (this.peek() && this.peek()?.kind !== ")") {
        args.push(this.parseOr());
        while (this.peek() && this.peek()?.kind === ",") {
          this.next();
          args.push(this.parseOr());
        }
      }
      this.expect(")");
      checkArguments(t.value, args.length);
      return { func: t.value, args };
    }
    throw new Error(
      `Unexpected token in $filter: ${t.kind} ${"value" in t ? t.value : ""}`,
    );
  }
}

// Checks the AST against one row. We don't know how to read a property off the row
// ourselves - that's what `resolve(row, path)` is for, since only the caller knows the
// entity type and how to "walk" a navigation property to get there.
function evaluate(node: Node, row: Row, resolve: Resolve): Value {
  spend();
  if ("literal" in node) return { value: node.literal, type: node.type };
  // Before node.path: lambda nodes also have a path (the collection)
  if ("lambda" in node)
    return { value: evaluateLambda(node, row, resolve), type: "Edm.Boolean" };
  if ("path" in node) return resolve(row, node.path);
  if ("these" in node) {
    if (!resolve.aggregate)
      throw new Error(
        "$these/aggregate(...) is only allowed in a groupby's filter in $apply",
      );
    return resolve.aggregate(node.these);
  }
  if ("not" in node) return not(evaluate(node.expr, row, resolve));
  if ("neg" in node) {
    const v = evaluate(node.expr, row, resolve);
    // 0 - 0 is 0, and a double's negated zero is -0, which dividing by shows
    if (/^Edm\.(Double|Single)$/.test(v.type ?? "") && !isNull(v))
      return { value: -num(v), type: v.type };
    return arithmetic("sub", { value: 0, type: v.type }, v);
  }
  if ("func" in node)
    return callFunction(
      node.func,
      node.args.map((a) => evaluate(a, row, resolve)),
    );

  const l = evaluate(node.left, row, resolve);
  if ("in" in node) {
    return {
      value: node.list.some(
        (item) => compare(l, evaluate(item, row, resolve)) === 0,
      ),
      type: "Edm.Boolean",
    };
  }
  switch (node.op) {
    case "and":
      return logical(false, l, () => evaluate(node.right, row, resolve));
    case "or":
      return logical(true, l, () => evaluate(node.right, row, resolve));
  }
  const r = evaluate(node.right, row, resolve);
  switch (node.op) {
    case "has":
      return { value: hasFlags(l, r), type: "Edm.Boolean" };
    case "eq":
      return { value: compare(l, r) === 0, type: "Edm.Boolean" };
    case "ne":
      return { value: compare(l, r) !== 0, type: "Edm.Boolean" };
    case "gt":
      return { value: compare(l, r) > 0, type: "Edm.Boolean" };
    case "ge":
      return { value: compare(l, r) >= 0, type: "Edm.Boolean" };
    case "lt":
      return { value: compare(l, r) < 0, type: "Edm.Boolean" };
    case "le":
      return { value: compare(l, r) <= 0, type: "Edm.Boolean" };
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "divby":
    case "mod":
      return arithmetic(node.op, l, r);
  }
  throw new Error(`Unsupported operator ${node.op}`);
}

const LAMBDA_WORK = 50;

const INTEGER = /^Edm\.(Byte|SByte|Int16|Int32|Int64)$/;

// The type of an arithmetic result, by the spec's numeric promotion: a Double or Single
// operand makes it an Edm.Double, then a Decimal one (or divby) an Edm.Decimal, and integers
// stay integers, Edm.Int64 if either is one. A null literal takes the other side's type.
// Anything else (a string compared as a number) is an Edm.Double, as it always was.
function arithmeticType(
  op: string,
  left: string | null,
  right: string | null,
): string {
  const types = [left, right].filter((t): t is string => t !== null);
  if (types.some((t) => /^Edm\.(Double|Single)$/.test(t))) return "Edm.Double";
  if (op === "divby" || types.includes("Edm.Decimal")) return "Edm.Decimal";
  if (types.length && types.every((t) => INTEGER.test(t)))
    return types.includes("Edm.Int64") ? "Edm.Int64" : "Edm.Int32";
  return "Edm.Double";
}

// An integer result, every digit kept: an Int64 is text internally (see toInternal), and JS's
// / and % on bigints round towards zero and keep the dividend's sign, as OData's do. One that
// isn't a value of its type is an error, as in a database.
function integerArithmetic(
  op: string,
  a: bigint,
  b: bigint,
  type: string,
): PrimitiveValue {
  if ((op === "div" || op === "mod") && b === 0n)
    throw new Error("Division by zero");
  const value =
    op === "add"
      ? a + b
      : op === "sub"
        ? a - b
        : op === "mul"
          ? a * b
          : op === "mod"
            ? a % b
            : a / b;
  if (!inIntegerRange(value, type))
    throw new Error(`${a} ${op} ${b} is out of range for ${type}`);
  return type === "Edm.Int64" ? String(value) : Number(value);
}

// A decimal result of add, sub, mul or mod, as text without trailing zeros; undefined when an
// operand isn't a decimal
function decimalArithmetic(op: string, l: Value, r: Value): string | undefined {
  const a = decimalUnits(l.value),
    b = decimalUnits(r.value);
  if (a === undefined || b === undefined) return undefined;
  const value =
    op === "add"
      ? a + b
      : op === "sub"
        ? a - b
        : op === "mul"
          ? (a * b) / 10n ** BigInt(DECIMAL_DIGITS)
          : a % b;
  const text = decimalText(value, DECIMAL_DIGITS);
  return text.replace(/\.?0+$/, "");
}

// add, sub, mul, div, divby, mod. Null when either side is null. Integers and decimals keep
// every digit. div of two integers rounds towards zero (5 div 2 is 2), divby doesn't (5 divby
// 2 is 2.5), and dividing an integer or a decimal by zero is an error. A quotient of decimals
// has no end, so it's cut to 15 significant digits.
function arithmetic(op: string, l: Value, r: Value): Value {
  spend(longText(l.value) + longText(r.value));
  const type = arithmeticType(op, l.type, r.type);
  if (l.value === null || l.value === undefined) return { value: null, type };
  if (r.value === null || r.value === undefined) return { value: null, type };
  if (
    INTEGER.test(type) &&
    INT64.test(String(l.value)) &&
    INT64.test(String(r.value))
  )
    return {
      value: integerArithmetic(
        op,
        BigInt(String(l.value)),
        BigInt(String(r.value)),
        type,
      ),
      type,
    };
  const a = num(l),
    b = num(r);
  const exact = INTEGER.test(type) || type === "Edm.Decimal";
  if ((op === "div" || op === "divby" || op === "mod") && b === 0 && exact)
    throw new Error("Division by zero");
  if (type === "Edm.Decimal" && ["add", "sub", "mul", "mod"].includes(op)) {
    const value = decimalArithmetic(op, l, r);
    if (value === undefined)
      throw new Error(
        `A number here has more digits than a ${type} can calculate with`,
      );
    return { value, type };
  }
  let value: number;
  switch (op) {
    case "add":
      value = a + b;
      break;
    case "sub":
      value = a - b;
      break;
    case "mul":
      value = a * b;
      break;
    case "mod":
      value = a % b;
      break;
    default:
      value = INTEGER.test(type) ? Math.trunc(a / b) : a / b;
  }
  if (type === "Edm.Decimal") {
    if (!Number.isFinite(value))
      throw new Error(
        `A number here has more digits than a ${type} can calculate with`,
      );
    value = Number(value.toPrecision(15));
  }
  return { value, type };
}

// any: pred holds for at least one item; all: for every item (true when there are none);
// any(): there is an item. In pred, <variable>/... reads the item (the variable alone is the
// item, in a primitive collection); $it/... and other paths read the outer entity.
function evaluateLambda(
  node: Extract<Node, { lambda: string }>,
  row: Row,
  resolve: Resolve,
): boolean {
  const coll = resolve.collection(row, node.path);
  const items: unknown[] = "rows" in coll ? coll.rows : coll.values;
  // Following a navigation is far more than a step of an expression (see work.ts)
  spend(LAMBDA_WORK);
  const { variable, predicate } = node;
  if (!variable || !predicate) return items.length > 0;
  const prop = "prop" in coll ? coll.prop : undefined;

  const split = (path: string) => {
    const [head, ...rest] = path.split("/");
    return { head, rest: rest.join("/") };
  };
  // Value of a collection-valued property's item: the item, or a field of a complex item
  const itemValue = (item: unknown, rest: string): Value => {
    if (!rest) return { value: item, type: prop?.elementType ?? null };
    const field = prop?.complexType && own(prop.complexType.properties, rest);
    if (!field)
      throw new Error(`Unknown property ${node.variable}/${rest} in $filter`);
    const fields = item as Record<string, unknown> | null | undefined;
    return { value: fields?.[rest] ?? null, type: field.type };
  };
  const scoped = (item: unknown): Resolve => {
    const inner = (_: Row, path: string): Value => {
      const { head, rest } = split(path);
      if (head === variable)
        return "rows" in coll
          ? coll.resolve(item as Row, rest)
          : itemValue(item, rest);
      return resolve(row, head === "$it" ? rest : path);
    };
    inner.collection = (_: Row, path: string): Collection => {
      const { head, rest } = split(path);
      if (head === variable) {
        if (!("rows" in coll))
          throw new Error(`${path} is not a collection in $filter`);
        return coll.resolve.collection(item as Row, rest);
      }
      return resolve.collection(row, head === "$it" ? rest : path);
    };
    inner.aggregate = resolve.aggregate;
    return inner;
  };
  // The item reaches its own fields through scoped(item), which ignores the row argument
  const holds = (item: unknown) =>
    truthy(evaluate(predicate, item as Row, scoped(item)));
  return node.lambda === "any" ? items.some(holds) : items.every(holds);
}

function truthy(v: Value): boolean {
  return v.value === true;
}
function isNull(v: Value): boolean {
  return v.value === null || v.value === undefined;
}
// null is unknown: not null is null
function not(v: Value): Value {
  return { value: isNull(v) ? null : !truthy(v), type: "Edm.Boolean" };
}
// and, or. decides: the value that settles it whatever the other side is, null included (false
// for and, true for or). Otherwise a null leaves it unknown, and the right side isn't read
// once the left one has settled it.
function logical(decides: boolean, l: Value, right: () => Value): Value {
  const settles = (v: Value) => !isNull(v) && truthy(v) === decides;
  if (settles(l)) return { value: decides, type: "Edm.Boolean" };
  const r = right();
  if (settles(r)) return { value: decides, type: "Edm.Boolean" };
  return {
    value: isNull(l) || isNull(r) ? null : !decides,
    type: "Edm.Boolean",
  };
}
// A value as a number. A string may hold one (see arithmeticType); text that doesn't would be
// NaN, and a date or a boolean isn't one.
function num(v: Value): number {
  const n = Number(v.value);
  if (
    !isNumericType(v.type ?? "") &&
    (Number.isNaN(n) || typeof v.value === "boolean")
  )
    throw new Error(`Expected a number, not ${str(v)}`);
  return n;
}
function str(v: Value): string {
  return String(v.value);
}

// The type two sides compare in. Between numbers the widest, so that a Decimal keeps its
// digits against an Int64 and a Double is compared as doubles, which it is
function comparedAs(left: string | null, right: string | null): string | null {
  if (left && right && isNumericType(left) && isNumericType(right)) {
    const float = [left, right].find((t) => /Double|Single/.test(t));
    return (
      float ?? ([left, right].includes("Edm.Decimal") ? "Edm.Decimal" : left)
    );
  }
  return left && left !== "Edm.String" ? left : right;
}

// What comparing a value costs past a step of an expression: a text long enough to matter is
// read again for every row
const longText = (value: unknown) =>
  typeof value === "string" && value.length > 256 ? value.length : 0;

// Whichever side is an actual property sets the type - that's what lets us compare
// a plain string literal against a Decimal or DateTime property, or a bare V4 date against
// a full timestamp, without the caller having to know or care.
function compare(l: Value, r: Value): number {
  spend(longText(l.value) + longText(r.value));
  // An enum is its number, whatever its members are called
  const enumOf = l.enumOf ?? r.enumOf;
  if (enumOf && !isNull(l) && !isNull(r)) {
    const a = enumNumber(l.value, enumOf),
      b = enumNumber(r.value, enumOf);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const type = comparedAs(l.type, r.type);
  const fraction = l.fraction ?? r.fraction;
  const shown = (value: unknown) =>
    fraction === undefined || value === null || value === undefined
      ? value
      : withPrecision(value as PropertyValue, fraction);
  const a = toComparable(shown(l.value), type);
  const b = toComparable(shown(r.value), type);
  // What can't be read as the type isn't null, which it would equal
  for (const [side, comparable] of [
    [l, a],
    [r, b],
  ] as const)
    if (comparable === null && !isNull(side))
      throw new Error(`${str(side)} is not a value of ${type}`);
  if (a === null || b === null) return a === b ? 0 : NaN;
  // Not a - b, which is NaN for INF and INF. NaN itself stays equal to nothing.
  if (
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint")
  )
    return a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN;
  const sa = String(a),
    sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

const COMPARISONS = ["eq", "ne", "gt", "ge", "lt", "le"];

// Whether an enum's value holds all the members of another: a flags value is several, Read,Write
function hasFlags(l: Value, r: Value): boolean | null {
  if (isNull(l) || isNull(r)) return null;
  if (l.enumOf) {
    const flags = enumNumber(r.value, l.enumOf);
    return (enumNumber(l.value, l.enumOf) & flags) === flags;
  }
  const held = String(l.value).split(",");
  return String(r.value)
    .split(",")
    .every((member) => held.includes(member));
}

// A decimal as a whole number, every digit kept. units: see decimalUnits. The / of bigints goes
// towards zero, so what's left has the sign of units.
function wholeUnits(name: string, units: bigint): bigint {
  const one = 10n ** BigInt(DECIMAL_DIGITS);
  const whole = units / one,
    rest = units % one;
  if (rest === 0n) return whole;
  const away = rest < 0n ? -1n : 1n;
  if (name === "floor") return rest < 0n ? whole - 1n : whole;
  if (name === "ceiling") return rest > 0n ? whole + 1n : whole;
  return rest * away * 2n >= one ? whole + away : whole;
}

// round, floor and ceiling: a value of the type they're given, as expressionType says
function rounded(name: string, v: Value): Value {
  spend(longText(v.value));
  if (v.type && INTEGER.test(v.type)) return v;
  const units = v.type === "Edm.Decimal" ? decimalUnits(v.value) : undefined;
  if (units !== undefined)
    return { value: String(wholeUnits(name, units)), type: "Edm.Decimal" };
  const n = num(v);
  // The spec rounds a midpoint away from zero, Math.round towards +Infinity (-2.5 -> -2)
  const value =
    name === "round"
      ? Math.sign(n) * Math.round(Math.abs(n))
      : name === "floor"
        ? Math.floor(n)
        : Math.ceil(n);
  return {
    value,
    type: v.type && isNumericType(v.type) ? v.type : "Edm.Double",
  };
}

function callFunction(name: string, args: Value[]): Value {
  // The spec's rule for all of them. Round, floor and ceiling give their argument's type.
  if (args.some(isNull))
    return { value: null, type: own(FUNCTION_TYPES, name) ?? args[0].type };
  const S = (i: number) => str(args[i]);
  const N = (i: number) => num(args[i]);
  const bool = (value: boolean): Value => ({ value, type: "Edm.Boolean" });
  const string = (value: string): Value => ({ value, type: "Edm.String" });
  const number = (value: number): Value => ({ value, type: "Edm.Int32" });
  const date = (i: number) => {
    const { value } = args[i];
    const moment = new Date(typeof value === "string" ? toMillis(value) : NaN);
    if (Number.isNaN(moment.getTime()))
      throw new Error(`${name} needs a date or a time, not ${S(i)}`);
    return moment;
  };
  // Of a time of day, whose text is all it has; of anything else, its date
  const clock = (index: number, ofDate: (d: Date) => number) =>
    args[0].type === "Edm.TimeOfDay"
      ? Math.trunc(Number(String(args[0].value).split(":")[index]))
      : ofDate(date(0));
  switch (name) {
    case "substringof":
      return bool(S(1).includes(S(0))); // V2 flipped the args: substringof(needle, haystack)
    case "contains":
      return bool(S(0).includes(S(1))); // V4 fixed it: contains(haystack, needle)
    case "startswith":
      return bool(S(0).startsWith(S(1)));
    case "endswith":
      return bool(S(0).endsWith(S(1)));
    case "tolower":
      return string(S(0).toLowerCase());
    case "toupper":
      return string(S(0).toUpperCase());
    case "trim":
      return string(S(0).trim());
    case "length":
      return number(S(0).length);
    case "indexof":
      return number(S(0).indexOf(S(1)));
    case "concat":
      spend(S(0).length + S(1).length);
      return string(S(0) + S(1));
    case "substring":
      return string(
        args.length > 2
          ? S(0).substring(N(1), N(1) + N(2))
          : S(0).substring(N(1)),
      );
    case "replace": {
      // Before the split as well as the join: a split of text long enough ends the process,
      // beyond any catch
      spend(S(0).length);
      const parts = S(0).split(S(1));
      spend((parts.length - 1) * S(2).length);
      return string(parts.join(S(2)));
    }
    case "year":
      return number(date(0).getUTCFullYear());
    case "month":
      return number(date(0).getUTCMonth() + 1);
    case "day":
      return number(date(0).getUTCDate());
    case "hour":
      return number(clock(0, (d) => d.getUTCHours()));
    case "minute":
      return number(clock(1, (d) => d.getUTCMinutes()));
    case "second":
      return number(clock(2, (d) => d.getUTCSeconds()));
    case "date":
      return { value: date(0).toISOString().slice(0, 10), type: "Edm.Date" };
    case "time":
      return {
        // As fine as the moment: Date's milliseconds, or the digits past them in its text
        value: (
          String(args[0].value).match(/T(\d{2}:\d{2}:\d{2}\.\d{4,})/)?.[1] ??
          date(0).toISOString().slice(11, 23)
        ).replace(/\.(\d*?)0*$/, (_, digits: string) =>
          digits ? `.${digits}` : "",
        ),
        type: "Edm.TimeOfDay",
      };
    case "now":
      return { value: new Date().toISOString(), type: "Edm.DateTimeOffset" };
    case "round":
    case "floor":
    case "ceiling":
      return rounded(name, args[0]);
    default:
      throw new Error(`Unsupported $filter function ${name}`);
  }
}

// Parsing and evaluating recurse once per level of the expression, so one nested deeply
// enough - thousands of parentheses, or of ors in a row - runs out of stack. That's the
// client's expression, not a bug here: say so instead of passing V8's message on.
function bounded<T>(run: () => T): T {
  try {
    return run();
  } catch (e) {
    if (e instanceof RangeError && /call stack/i.test(e.message))
      throw new Error("Expression nested too deeply in $filter", { cause: e });
    throw e;
  }
}

// Caller (the protocol module) needs to give us parseLiteral(text) and a
// typedLiteralPrefixes set; matchBareLiteral(text) -> { value, type, length } | undefined
// is optional, only V4 needs it since V2 always types its literals explicitly.
function compileFilter(
  text: string,
  protocol: LiteralSyntax,
  scope?: Scope,
  paths?: PathScope,
): (row: Row, resolve: Resolve) => boolean {
  const ast = bounded(() =>
    new Parser(tokenize(text, protocol, scope)).parse(),
  );
  if (paths) bounded(() => checkPaths(ast, paths, new Map()));
  return (row, resolve) => bounded(() => truthy(evaluate(ast, row, resolve)));
}

// Throws on a path no row could have: from the text alone, as evaluating gets to a path only
// when a row does, and when and and or haven't settled without it.
function checkPaths(
  node: Node,
  root: PathScope,
  variables: Map<string, PathScope | undefined>,
): void {
  // Where a path starts, as evaluateLambda reads it: its first part may be a lambda's variable
  // or $it. undefined for an item of a collection property, which has no paths to check here.
  const from = (path: string): { scope?: PathScope; rest: string } => {
    const [head, ...parts] = path.split("/");
    const rest = parts.join("/");
    if (variables.has(head)) return { scope: variables.get(head), rest };
    return head === "$it" ? { scope: root, rest } : { scope: root, rest: path };
  };
  const check = (child: Node) => checkPaths(child, root, variables);
  // Text compared with a number has to read as one, whatever rows there are: '1.5' does, and
  // a typo would otherwise be an empty answer
  const typed = (path: string) => {
    const { scope, rest } = from(path);
    return scope && rest ? scope.check(rest) : "";
  };
  const checkText = (text: Node, other: Node) => {
    if (!("literal" in text) || typeof text.literal !== "string") return;
    if (text.type !== "Edm.String" || isNumberText(text.literal)) return;
    let type: string | null;
    try {
      type = expressionType(other, typed);
    } catch {
      return; // the check of other, or evaluating it, says what's wrong
    }
    if (type && isNumericType(type))
      throw new Error(`'${text.literal}' is not a value of ${type}`);
  };
  if ("lambda" in node) {
    const { scope, rest } = from(node.path);
    const items = scope && rest ? scope.collection(rest) : undefined;
    if (node.variable && node.predicate)
      checkPaths(
        node.predicate,
        root,
        new Map(variables).set(node.variable, items),
      );
  } else if ("path" in node) {
    const { scope, rest } = from(node.path);
    if (scope && rest) scope.check(rest);
  } else if ("op" in node) {
    check(node.left);
    check(node.right);
    if (COMPARISONS.includes(node.op)) {
      checkText(node.left, node.right);
      checkText(node.right, node.left);
    }
  } else if ("in" in node) {
    check(node.left);
    node.list.forEach(check);
    for (const item of node.list) checkText(item, node.left);
  } else if ("expr" in node) check(node.expr);
  else if ("func" in node) node.args.forEach(check);
}

// The Edm type each function gives; round, floor and ceiling give their argument's
const ROUNDING = ["round", "floor", "ceiling"];
// The spec's functions that aren't implemented (names are lower-cased when tokenized)
const UNSUPPORTED_FUNCTIONS = [
  "cast",
  "isof",
  "fractionalseconds",
  "totaloffsetminutes",
  "totalseconds",
  "mindatetime",
  "maxdatetime",
  "matchespattern",
];
// How many arguments a function takes, at least and at most: one unless it's here
const FUNCTION_ARGUMENTS: Record<string, [number, number]> = {
  now: [0, 0],
  substringof: [2, 2],
  contains: [2, 2],
  startswith: [2, 2],
  endswith: [2, 2],
  concat: [2, 2],
  indexof: [2, 2],
  substring: [2, 3],
  replace: [3, 3],
};

// Checked when it's read, so a mistake is a 400 even when no row gets to it
function checkArguments(name: string, count: number): void {
  const [min, max] = own(FUNCTION_ARGUMENTS, name) ?? [1, 1];
  if (count < min || count > max)
    throw new Error(
      `${name} takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, not ${count}`,
    );
}

const FUNCTION_TYPES: Record<string, string> = {
  substringof: "Edm.Boolean",
  contains: "Edm.Boolean",
  startswith: "Edm.Boolean",
  endswith: "Edm.Boolean",
  tolower: "Edm.String",
  toupper: "Edm.String",
  trim: "Edm.String",
  concat: "Edm.String",
  substring: "Edm.String",
  replace: "Edm.String",
  length: "Edm.Int32",
  indexof: "Edm.Int32",
  year: "Edm.Int32",
  month: "Edm.Int32",
  day: "Edm.Int32",
  hour: "Edm.Int32",
  minute: "Edm.Int32",
  second: "Edm.Int32",
  date: "Edm.Date",
  time: "Edm.TimeOfDay",
  now: "Edm.DateTimeOffset",
};

// The type an expression gives, known before any row is read: $compute declares a property
// of it. typeOf gives a property path's type. Null for the null literal alone.
function expressionType(
  node: Node,
  typeOf: (path: string) => string,
): string | null {
  if ("literal" in node) return node.type;
  if ("lambda" in node || "not" in node || "in" in node) return "Edm.Boolean";
  if ("path" in node) return typeOf(node.path);
  if ("these" in node)
    throw new Error("$these/aggregate(...) is only allowed in $apply");
  if ("neg" in node) {
    const type = expressionType(node.expr, typeOf);
    return arithmeticType("sub", type, type);
  }
  if ("func" in node) {
    const args = node.args.map((a) => expressionType(a, typeOf));
    if (ROUNDING.includes(node.func))
      return args[0] && isNumericType(args[0]) ? args[0] : "Edm.Double";
    const type = FUNCTION_TYPES[node.func];
    if (!type) throw new Error(`Unsupported function ${node.func}`);
    return type;
  }
  const left = expressionType(node.left, typeOf);
  const right = expressionType(node.right, typeOf);
  if (
    ["and", "or", "eq", "ne", "gt", "ge", "lt", "le", "has"].includes(node.op)
  )
    return "Edm.Boolean";
  for (const type of [left, right])
    if (type !== null && !isNumericType(type))
      throw new Error(`${node.op} needs numbers, not ${type}`);
  return arithmeticType(node.op, left, right);
}

// An expression as $compute uses it: its value for a row, and its type
function compileExpression(
  text: string,
  protocol: LiteralSyntax,
  scope?: Scope,
): {
  evaluate(row: Row, resolve: Resolve): Value;
  type(typeOf: (path: string) => string): string | null;
} {
  const ast = bounded(() =>
    new Parser(tokenize(text, protocol, scope)).parse(),
  );
  return {
    evaluate: (row, resolve) => bounded(() => evaluate(ast, row, resolve)),
    type: (typeOf) => bounded(() => expressionType(ast, typeOf)),
  };
}

export { compileFilter, compileExpression, scopeOf };
