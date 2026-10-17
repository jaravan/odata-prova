// Everything for parsing and running $filter is here: tokenizer, recursive-descent
// parser, and an evaluator that turns the AST into (row, resolve) => boolean.
// V2 and V4 share this whole pipeline - the only real difference is how literals are
// spelled on the wire (V2 wants datetime'...', guid'...', 12L; V4 just writes
// 2025-01-20 or a bare GUID), so that's the one bit each protocol module has to supply.
//
// Precedence goes or < and < not < comparison (eq/ne/gt/ge/lt/le/in) < add/sub < mul/div/mod
// < unary minus < primary (literal, property path, function call, parens) - standard hierarchy.

import type { Literal, Property, PropertyValue, Row } from "./model.ts";
import { own } from "./query.ts";
import { isNumericType, toComparable, toMillis } from "./types.ts";

// What a protocol module supplies: how its literals are spelled
export interface LiteralSyntax {
  typedLiteralPrefixes: Set<string>;
  parseLiteral(text: string): Literal;
  // V4 only: GUIDs, dates and times written without a prefix
  matchBareLiteral?(text: string): (Literal & { length: number }) | undefined;
}

// A value while evaluating: a property's or a literal's, with its Edm type
type Value = Literal;

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

function tokenize(input: string, protocol: LiteralSyntax): Token[] {
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
    const word = input.slice(i).match(/^\$?[A-Za-z_][A-Za-z0-9_./]*/);
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
      const lower = w.toLowerCase();
      if (KEYWORDS.has(lower)) tokens.push({ kind: "op", value: lower });
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
      } else if (this.isOp("eq", "ne", "gt", "ge", "lt", "le")) {
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
  if ("not" in node)
    return {
      value: !truthy(evaluate(node.expr, row, resolve)),
      type: "Edm.Boolean",
    };
  if ("neg" in node) {
    const v = evaluate(node.expr, row, resolve);
    const type = arithmeticType("sub", v.type, v.type);
    return { value: v.value === null ? null : -num(v), type };
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
      return {
        value: truthy(l) && truthy(evaluate(node.right, row, resolve)),
        type: "Edm.Boolean",
      };
    case "or":
      return {
        value: truthy(l) || truthy(evaluate(node.right, row, resolve)),
        type: "Edm.Boolean",
      };
  }
  const r = evaluate(node.right, row, resolve);
  switch (node.op) {
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

// add, sub, mul, div, divby, mod. Null when either side is null. div of two integers rounds
// towards zero (5 div 2 is 2), divby doesn't (5 divby 2 is 2.5), and dividing an integer or a
// decimal by zero is an error. A decimal result is cut to 15 significant digits, which drops
// the noise of binary floating point (0.1 add 0.2 is 0.3).
function arithmetic(op: string, l: Value, r: Value): Value {
  const type = arithmeticType(op, l.type, r.type);
  if (l.value === null || l.value === undefined) return { value: null, type };
  if (r.value === null || r.value === undefined) return { value: null, type };
  const a = num(l),
    b = num(r);
  const exact = INTEGER.test(type) || type === "Edm.Decimal";
  if ((op === "div" || op === "divby" || op === "mod") && b === 0 && exact)
    throw new Error("Division by zero");
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
  if (type === "Edm.Decimal") value = Number(value.toPrecision(15));
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
function num(v: Value): number {
  return Number(v.value);
}
function str(v: Value): string {
  return v.value === null || v.value === undefined ? "" : String(v.value);
}

// Whichever side is an actual property sets the type - that's what lets us compare
// a plain string literal against a Decimal or DateTime property, or a bare V4 date against
// a full timestamp, without the caller having to know or care.
function compare(l: Value, r: Value): number {
  const type = l.type && l.type !== "Edm.String" ? l.type : r.type;
  const a = toComparable(l.value, type);
  const b = toComparable(r.value, type);
  if (a === null || b === null) return a === b ? 0 : NaN;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a),
    sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function callFunction(name: string, args: Value[]): Value {
  const S = (i: number) => str(args[i]);
  const N = (i: number) => num(args[i]);
  const bool = (value: boolean): Value => ({ value, type: "Edm.Boolean" });
  const string = (value: string): Value => ({ value, type: "Edm.String" });
  const number = (value: number): Value => ({ value, type: "Edm.Int32" });
  const date = (i: number) => new Date(toMillis(args[i].value as string));
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
      return string(S(0) + S(1));
    case "substring":
      return string(
        args.length > 2
          ? S(0).substring(N(1), N(1) + N(2))
          : S(0).substring(N(1)),
      );
    case "replace":
      return string(S(0).split(S(1)).join(S(2)));
    case "year":
      return number(date(0).getUTCFullYear());
    case "month":
      return number(date(0).getUTCMonth() + 1);
    case "day":
      return number(date(0).getUTCDate());
    case "hour":
      return number(date(0).getUTCHours());
    case "minute":
      return number(date(0).getUTCMinutes());
    case "second":
      return number(date(0).getUTCSeconds());
    case "date":
      return { value: date(0).toISOString().slice(0, 10), type: "Edm.Date" };
    case "time":
      return {
        value: date(0).toISOString().slice(11, 19),
        type: "Edm.TimeOfDay",
      };
    case "now":
      return { value: new Date().toISOString(), type: "Edm.DateTimeOffset" };
    case "round":
      return number(Math.round(N(0)));
    case "floor":
      return number(Math.floor(N(0)));
    case "ceiling":
      return number(Math.ceil(N(0)));
    default:
      throw new Error(`Unsupported $filter function ${name}`);
  }
}

// Caller (the protocol module) needs to give us parseLiteral(text) and a
// typedLiteralPrefixes set; matchBareLiteral(text) -> { value, type, length } | undefined
// is optional, only V4 needs it since V2 always types its literals explicitly.
function compileFilter(
  text: string,
  protocol: LiteralSyntax,
): (row: Row, resolve: Resolve) => boolean {
  const ast = new Parser(tokenize(text, protocol)).parse();
  return (row, resolve) => truthy(evaluate(ast, row, resolve));
}

// The Edm type each function gives; round, floor and ceiling give their argument's
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
    if (["round", "floor", "ceiling"].includes(node.func))
      return args[0] && isNumericType(args[0]) ? args[0] : "Edm.Double";
    const type = FUNCTION_TYPES[node.func];
    if (!type) throw new Error(`Unsupported function ${node.func}`);
    return type;
  }
  const left = expressionType(node.left, typeOf);
  const right = expressionType(node.right, typeOf);
  if (["and", "or", "eq", "ne", "gt", "ge", "lt", "le"].includes(node.op))
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
): {
  evaluate(row: Row, resolve: Resolve): Value;
  type(typeOf: (path: string) => string): string | null;
} {
  const ast = new Parser(tokenize(text, protocol)).parse();
  return {
    evaluate: (row, resolve) => evaluate(ast, row, resolve),
    type: (typeOf) => expressionType(ast, typeOf),
  };
}

export { compileFilter, compileExpression };
