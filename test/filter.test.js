import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileFilter } from "../lib/filter.js";
import v2 from "../lib/protocols/v2.js";
import v4 from "../lib/protocols/v4.js";

const types = {
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
const resolve = (r, path) => ({ value: r[path], type: types[path] });
const run = (protocol, text) => compileFilter(text, protocol)(row, resolve);

describe("$filter grammar (shared)", () => {
  const cases = [
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
});
