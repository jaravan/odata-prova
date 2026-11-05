import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, type TestServer } from "./helpers.ts";
import { compileFilter } from "../lib/filter.ts";
import v2 from "../lib/protocols/v2.ts";
import v4 from "../lib/protocols/v4.ts";

const EDM_TYPES = path.join(import.meta.dirname, "fixtures", "EdmTypes");

const types: Record<string, string> = {
  Text: "Edm.String",
  Yes: "Edm.Boolean",
  No: "Edm.Boolean",
  Qty: "Edm.Int32",
  NoText: "Edm.String",
  NoFlag: "Edm.Boolean",
  NoQty: "Edm.Int32",
  NoAmount: "Edm.Decimal",
  NoFloat: "Edm.Double",
  NoDay: "Edm.Date",
  NoWhen: "Edm.DateTimeOffset",
  NoTime: "Edm.TimeOfDay",
};
const row = {
  Text: "Acme",
  Yes: true,
  No: false,
  Qty: 7,
  NoText: null,
  NoFlag: null,
  NoQty: null,
  NoAmount: null,
  NoFloat: null,
  NoDay: null,
  NoWhen: null,
  NoTime: null,
};
const resolve = (r: Record<string, unknown>, name: string) => ({
  value: r[name],
  type: types[name],
});
resolve.collection = () => {
  throw new Error("No collections in this row");
};
const matches = (text: string, protocol = v4) =>
  compileFilter(text, protocol)(row, resolve);
// A value is null when eq null finds it, which false isn't
const isNull = (text: string) => matches(`(${text}) eq null`);

describe("null in $filter, as the spec has it", () => {
  // URL Conventions 5.1.1.4: "If a parameter of a canonical function is null, the function
  // returns null"
  const functions = [
    "contains(NoText,'a')",
    "contains(Text,NoText)",
    "startswith(NoText,'a')",
    "endswith(NoText,'a')",
    "length(NoText)",
    "indexof(NoText,'a')",
    "substring(NoText,1)",
    "substring(Text,NoQty)",
    "tolower(NoText)",
    "toupper(NoText)",
    "trim(NoText)",
    "concat(NoText,'a')",
    "concat('a',NoText)",
    "replace(NoText,'a','b')",
    "replace(Text,'A',NoText)",
    "year(NoDay)",
    "month(NoDay)",
    "day(NoDay)",
    "hour(NoWhen)",
    "minute(NoWhen)",
    "second(NoWhen)",
    "hour(NoTime)",
    "date(NoWhen)",
    "time(NoWhen)",
    "round(NoAmount)",
    "floor(NoFloat)",
    "ceiling(NoQty)",
  ];
  for (const f of functions)
    it(`${f} -> null`, () => assert.equal(isNull(f), true));

  it("the values a null used to read as match nothing", () => {
    assert.equal(matches("year(NoDay) eq 1970"), false);
    assert.equal(matches("length(NoText) eq 0"), false);
    assert.equal(matches("tolower(NoText) eq ''"), false);
    assert.equal(matches("floor(NoFloat) eq 0"), false);
    assert.equal(matches("date(NoWhen) eq 1970-01-01"), false);
  });

  it("V2's substringof, too", () => {
    assert.equal(matches("(substringof('a',NoText)) eq null", v2), true);
  });

  it("a function without arguments isn't one of a null", () => {
    assert.equal(isNull("now()"), false);
  });

  // 5.1.1.1.9: "not null returns null"
  it("not null is null, which a filter leaves out", () => {
    assert.equal(matches("not NoFlag"), false);
    assert.equal(isNull("not NoFlag"), true);
    assert.equal(matches("not contains(NoText,'a')"), false);
    assert.equal(matches("not not NoFlag"), false);
  });

  // 5.1.1.1.3: gt returns false on a null, which is why this one holds
  it("not of a comparison with a null holds: the comparison is false, not null", () => {
    assert.equal(matches("not (NoQty gt 0)"), true);
    assert.equal(matches("not (NoQty eq 5)"), true);
  });

  // 5.1.1.1.7: "if one operand evaluates to null and the other operand to false, the and
  // operator returns false. All other combinations with null return null."
  it("and: false wins over null, and otherwise it's null", () => {
    assert.equal(matches("not (NoFlag and No)"), true);
    assert.equal(matches("not (No and NoFlag)"), true);
    assert.equal(isNull("NoFlag and Yes"), true);
    assert.equal(isNull("Yes and NoFlag"), true);
    assert.equal(isNull("NoFlag and NoFlag"), true);
  });

  // 5.1.1.1.8: the same, with true
  it("or: true wins over null, and otherwise it's null", () => {
    assert.equal(matches("NoFlag or Yes"), true);
    assert.equal(matches("Yes or NoFlag"), true);
    assert.equal(isNull("NoFlag or No"), true);
    assert.equal(isNull("No or NoFlag"), true);
    assert.equal(isNull("NoFlag or NoFlag"), true);
    assert.equal(matches("not (NoFlag or No)"), false);
  });

  // 5.1.1.1.10: "if one operand evaluates to null, the has operator returns null"
  it("has with a null is null", () => {
    assert.equal(isNull("NoText has 'a'"), true);
    assert.equal(matches("not (NoText has 'a')"), false);
  });

  it("without a null, not, and, or and has are as they were", () => {
    assert.equal(matches("not No"), true);
    assert.equal(matches("not Yes"), false);
    assert.equal(matches("Yes and Yes"), true);
    assert.equal(matches("Yes and No"), false);
    assert.equal(matches("No or Yes"), true);
    assert.equal(matches("No or No"), false);
    assert.equal(matches("Text has 'Acme'"), true);
  });
});

describe("null over HTTP", () => {
  let s: TestServer;
  before(async () => {
    s = await start(EDM_TYPES);
  });
  after(() => s.close());

  const q = encodeURIComponent;
  const ids = async (filter: string) => {
    const r = await get(`${s.v4}/Values?$filter=${q(filter)}`);
    assert.equal(r.status, 200);
    return r.body.value.map((v: { ID: number }) => v.ID);
  };

  it("$compute gives null for a function of a null, not a date of 1970", async () => {
    const r = await get(
      `${s.v4}/Values?$compute=${q("year(Day) add 1 as Next")}&$select=Next`,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.value, [{ Next: null }]);
  });

  it("$filter leaves out a row a function of a null can't say anything about", async () => {
    assert.deepEqual(await ids("year(Day) eq 1970"), []);
    assert.deepEqual(await ids("not (year(Day) eq 1970)"), [2]);
    assert.deepEqual(await ids("year(Day) eq null"), [2]);
  });
});
