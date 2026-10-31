// $search, V4's search expression: words and "phrases", joined by AND (or just a space), OR
// and NOT, in parentheses or not. NOT binds tightest, then AND, then OR:
//
//   open gmbh                  both
//   "steel ab"                 the phrase, as written
//   nordic OR pacific          either
//   (acme OR nordic) NOT open
//
// A term matches an entity when one of its string properties holds it, in any case: the spec
// leaves what a match is to the service. V2's search= (SAP Gateway's basic search) is read the
// same way.

import { HttpError } from "./query.ts";
import type { Row } from "./model.ts";

type SearchNode =
  | { term: string }
  | { not: SearchNode }
  | { and: [SearchNode, SearchNode] }
  | { or: [SearchNode, SearchNode] };

type Token =
  { kind: "(" | ")" | "AND" | "OR" | "NOT" } | { kind: "term"; value: string };

function invalid(text: string, why: string): HttpError {
  return new HttpError(400, `Invalid $search: ${why} in ${text}`);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === "(" || c === ")") {
      tokens.push({ kind: c });
      i++;
    } else if (c === '"') {
      // A phrase: \" and \\ escape a quote and a backslash
      let value = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        value += text[i++];
      }
      if (i >= text.length)
        throw invalid(text, "a phrase has no closing quote");
      if (!value) throw invalid(text, "an empty phrase");
      tokens.push({ kind: "term", value });
      i++;
    } else {
      const word = /^[^\s()"]+/.exec(text.slice(i))![0];
      i += word.length;
      tokens.push(
        word === "AND" || word === "OR" || word === "NOT"
          ? { kind: word }
          : { kind: "term", value: word },
      );
    }
  }
  return tokens;
}

function parseSearch(text: string): SearchNode {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos]?.kind;

  function or(): SearchNode {
    let node = and();
    while (peek() === "OR") {
      pos++;
      node = { or: [node, and()] };
    }
    return node;
  }
  function and(): SearchNode {
    let node = not();
    // AND, or nothing but space before the next term
    while (
      peek() === "AND" ||
      peek() === "term" ||
      peek() === "NOT" ||
      peek() === "("
    ) {
      if (peek() === "AND") pos++;
      node = { and: [node, not()] };
    }
    return node;
  }
  function not(): SearchNode {
    if (peek() === "NOT") {
      pos++;
      return { not: not() };
    }
    return primary();
  }
  function primary(): SearchNode {
    const token = tokens[pos++];
    if (!token) throw invalid(text, "a term is missing at the end");
    if (token.kind === "term") return { term: token.value.toLowerCase() };
    if (token.kind === "(") {
      const node = or();
      if (tokens[pos++]?.kind !== ")")
        throw invalid(text, "a parenthesis isn't closed");
      return node;
    }
    throw invalid(text, `${token.kind} where a term should be`);
  }

  if (!tokens.length) throw invalid(text, "nothing to search for");
  const node = or();
  if (pos < tokens.length)
    throw invalid(text, `${tokens[pos].kind} where nothing should be`);
  return node;
}

function matches(node: SearchNode, row: Row, props: string[]): boolean {
  if ("term" in node)
    return props.some(
      (p) =>
        row[p] !== null &&
        row[p] !== undefined &&
        String(row[p]).toLowerCase().includes(node.term),
    );
  if ("not" in node) return !matches(node.not, row, props);
  if ("and" in node) return node.and.every((n) => matches(n, row, props));
  return node.or.some((n) => matches(n, row, props));
}

// The rows that match the search expression, over the given string properties
function search(
  rows: readonly Row[],
  text: string,
  props: string[],
): readonly Row[] {
  const node = parseSearch(text);
  return rows.filter((row) => matches(node, row, props));
}

export { search, parseSearch };
