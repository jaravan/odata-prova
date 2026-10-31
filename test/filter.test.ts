import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileFilter, type LiteralSyntax } from "../lib/filter.ts";
import type { Row } from "../lib/model.ts";
import v2 from "../lib/protocols/v2.ts";
import v4 from "../lib/protocols/v4.ts";

const types: Record<string, string> = {
  Name: "Edm.String",
  Amount: "Edm.Decimal",
  Qty: "Edm.Int32",
  When: "Edm.DateTimeOffset",
  Day: "Edm.Date",
  Id: "Edm.Guid",
  Flag: "Edm.Boolean",
  Nothing: "Edm.String",
};
const row = {
  Name: "Acme Ltd",
  Amount: "12500.00",
  Qty: 7,
  When: "2025-01-20T10:00:00.000Z",
  Day: "2025-01-20",
  Id: "01234567-89ab-cdef-0123-456789abcdef",
  Flag: true,
  Nothing: null,
};
const resolve = (r: Row, path: string) => ({
  value: r[path],
  type: types[path],
});
// The row has no collections, so no lambda operators here (see lambda.test)
resolve.collection = () => {
  throw new Error("No collections in this row");
};
const run = (protocol: LiteralSyntax, text: string) =>
  compileFilter(text, protocol)(row, resolve);

describe("$filter grammar (shared)", () => {
  const cases: [string, boolean][] = [
    ["Name eq 'Acme Ltd'", true],
    ["Name ne 'Acme Ltd'", false],
    ["Amount gt 10000", true],
    ["Amount ge 12500.00 and Qty lt 10", true],
    ["Qty add 3 eq 10", true],
    ["Qty mul 2 sub 4 eq 10", true],
    ["Qty mod 4 eq 3", true],
    ["(Qty eq 1 or Qty eq 7) and not (Flag eq false)", true],
    ["startswith(Name,'Acme')", true],
    ["endswith(Name,'Ltd') eq true", true],
    ["tolower(Name) eq 'acme ltd'", true],
    ["length(Name) eq 8", true],
    ["indexof(Name,'Ltd') eq 5", true],
    ["substring(Name,5) eq 'Ltd'", true],
    ["substring(Name,0,4) eq 'Acme'", true],
    ["concat(Name,'!') eq 'Acme Ltd!'", true],
    ["replace(Name,' ','_') eq 'Acme_Ltd'", true],
    ["year(When) eq 2025 and month(When) eq 1 and day(When) eq 20", true],
    ["hour(When) eq 10", true],
    ["round(Amount) eq 12500", true],
    ["Nothing eq null", true],
    ["Name eq null", false],
    ["Name eq 'it''s'", false],
  ];
  for (const protocol of [v2, v4]) {
    for (const [text, expected] of cases) {
      it(`V${protocol.version}: ${text} -> ${expected}`, () =>
        assert.equal(run(protocol, text), expected));
    }
  }
});

describe("$filter arithmetic", () => {
  const cases: [string, boolean][] = [
    // Integers stay integers: div rounds towards zero, divby doesn't
    ["Qty div 2 eq 3", true],
    ["Qty divby 2 eq 3.5", true],
    ["0 sub Qty div 2 eq -3", true],
    ["Qty mod 4 eq 3", true],
    // A decimal or a double operand divides without rounding
    ["Amount div 1000 eq 12.5", true],
    ["Qty div 2.0 eq 3.5", true],
    ["0.1 add 0.2 eq 0.3", true],
    // Null on either side is null, which no comparison matches
    ["Nothing add 1 eq null", true],
    ["Nothing add 1 lt 5", false],
    // Negation: a minus before anything but a number
    ["-Qty eq -7", true],
    ["-Qty add 10 eq 3", true],
    ["-(Qty sub 10) eq 3", true],
    ["-length(Name) eq -8", true],
    ["- Qty eq -7", true],
    ["--Qty eq 7", true],
    ["-Nothing eq null", true],
    ["Qty mul -1 eq -7", true],
  ];
  for (const [text, expected] of cases)
    it(`${text} -> ${expected}`, () => assert.equal(run(v4, text), expected));

  it("an integer or a decimal divided by zero is an error; a double is INF", () => {
    assert.throws(() => run(v4, "Qty div 0 eq 1"), /Division by zero/);
    assert.throws(() => run(v4, "Amount mod 0 eq 1"), /Division by zero/);
    assert.equal(run(v2, "Qty div 0d gt 1000"), true);
  });
});

describe("$filter V2 literals", () => {
  it("datetime'...' compares against a timestamp", () => {
    assert.equal(run(v2, "When ge datetime'2025-01-01T00:00:00'"), true);
    assert.equal(run(v2, "When lt datetime'2025-01-01T00:00:00'"), false);
  });
  it("guid'...' and numeric suffixes", () => {
    assert.equal(
      run(v2, "Id eq guid'01234567-89ab-cdef-0123-456789abcdef'"),
      true,
    );
    assert.equal(run(v2, "Amount eq 12500M"), true);
    assert.equal(run(v2, "Qty eq 7L"), true);
  });
  it("substringof has V2 argument order", () => {
    assert.equal(run(v2, "substringof('cme',Name)"), true);
  });
});

describe("$filter V4 literals", () => {
  it("bare date, datetimeoffset and guid literals", () => {
    assert.equal(run(v4, "When ge 2025-01-01T00:00:00Z"), true);
    assert.equal(run(v4, "When ge 2025-01-01"), true);
    assert.equal(run(v4, "Day eq 2025-01-20"), true);
    assert.equal(run(v4, "Day eq 2025-01-20T00:00:00Z"), true);
    assert.equal(run(v4, "Id eq 01234567-89ab-cdef-0123-456789abcdef"), true);
  });
  it("contains has V4 argument order, in, date()", () => {
    assert.equal(run(v4, "contains(Name,'cme')"), true);
    assert.equal(run(v4, "Name in ('Foo','Acme Ltd')"), true);
    assert.equal(run(v4, "Qty in (1,2,3)"), false);
    assert.equal(run(v4, "date(When) eq 2025-01-20"), true);
  });
});

describe("$filter errors", () => {
  it("rejects unterminated strings, unknown functions and trailing input", () => {
    assert.throws(() => compileFilter("Name eq 'x", v2), /Unterminated/);
    assert.throws(() => run(v2, "nope(Name)"), /Unsupported \$filter function/);
    assert.throws(() => compileFilter("Name eq 'x' 'y'", v2), /trailing/);
  });

  it("rejects an expression nested too deeply, rather than passing on V8's error", () => {
    const parens = "(".repeat(50000) + "true" + ")".repeat(50000);
    assert.throws(
      () => run(v4, parens),
      /^Error: Expression nested too deeply/,
    );
    const ors = Array(50000).fill("Qty eq 1").join(" or ");
    assert.throws(() => run(v4, ors), /^Error: Expression nested too deeply/);
    // A value help's long list of ors is fine
    assert.equal(run(v4, Array(500).fill("Qty eq 7").join(" or ")), true);
  });
});

describe("$filter, as the spec defines it where JavaScript differs", () => {
  it("round() takes a midpoint away from zero: round(-2.5) is -3", () => {
    assert.equal(run(v4, "round(-2.5) eq -3"), true);
    assert.equal(run(v4, "round(2.5) eq 3"), true);
    assert.equal(run(v4, "round(-2.4) eq -2"), true);
  });

  it("durations compare by length, not as text: P1D is longer than PT1H", () => {
    assert.equal(run(v4, "duration'P1D' gt duration'PT1H'"), true);
    assert.equal(run(v4, "duration'PT90M' eq duration'PT1H30M'"), true);
    assert.equal(run(v4, "duration'-PT1S' lt duration'PT0S'"), true);
  });

  it("INF, -INF and NaN are V4 literals", () => {
    assert.equal(run(v4, "INF gt 1e308"), true);
    assert.equal(run(v4, "-INF lt 0"), true);
    assert.equal(run(v4, "NaN eq NaN"), false);
  });

  it("cast and isof -> an error saying they aren't supported, not 'Unknown property'", () => {
    for (const f of ["cast(Qty,Edm.String) eq '7'", "isof(Name,Edm.String)"])
      assert.throws(() => run(v4, f), /not supported/);
  });
});
