import { describe, it, before, after } from "node:test";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { toInternal, propToInternal } from "../lib/types.ts";
import { HttpError } from "../lib/query.ts";
import type { Property } from "../lib/model.ts";
import { start, get, send, type TestServer } from "./helpers.ts";

const EDM_TYPES = path.join(import.meta.dirname, "fixtures", "EdmTypes");

// A 400 InvalidValue, as a write with the value answers
function rejects(value: unknown, type: string) {
  assert.throws(
    () => toInternal(value, type),
    (e: unknown) =>
      e instanceof HttpError && e.status === 400 && e.code === "InvalidValue",
    `${type}: ${JSON.stringify(value)} should be rejected`,
  );
}

function prop(type: string, facets: Partial<Property> = {}): Property {
  return {
    name: "P",
    type,
    v2Type: type,
    nullable: true,
    sap: {},
    isCollection: false,
    elementType: type,
    ...facets,
  };
}

describe("integer values are checked against their type's range", () => {
  it("in range -> the number", () => {
    assert.equal(toInternal(255, "Edm.Byte"), 255);
    assert.equal(toInternal(-128, "Edm.SByte"), -128);
    assert.equal(toInternal("-32768", "Edm.Int16"), -32768);
    assert.equal(toInternal(2147483647, "Edm.Int32"), 2147483647);
    assert.equal(
      toInternal("-9223372036854775808", "Edm.Int64"),
      "-9223372036854775808",
    );
  });

  it("out of range -> 400", () => {
    rejects(256, "Edm.Byte");
    rejects(-1, "Edm.Byte");
    rejects(128, "Edm.SByte");
    rejects(32768, "Edm.Int16");
    rejects(2147483648, "Edm.Int32");
    rejects("9223372036854775808", "Edm.Int64");
    rejects("99999999999999999999999", "Edm.Int64");
  });
});

describe("dates and times are ISO 8601, checked against the calendar", () => {
  it("a date that doesn't exist -> 400, not the next month", () => {
    rejects("2025-02-30", "Edm.Date");
    rejects("2025-13-01", "Edm.Date");
    rejects("2025-02-29T10:00:00Z", "Edm.DateTimeOffset");
    assert.equal(toInternal("2024-02-29", "Edm.Date"), "2024-02-29");
  });

  it("text that isn't ISO 8601 -> 400, whatever the server's timezone", () => {
    for (const s of ["1", "March 7, 2025", "07.03.2025", "03/07/2025"]) {
      rejects(s, "Edm.Date");
      rejects(s, "Edm.DateTimeOffset");
    }
  });

  it("a spreadsheet's 2025/03/07 or 2025-03-07 10:00 is read as that day, in any timezone", () => {
    const script = `
      import { toInternal } from ${JSON.stringify(new URL("../lib/types.ts", import.meta.url).href)};
      console.log(JSON.stringify([
        toInternal("2025/03/07", "Edm.Date"),
        toInternal("2025-03-07 10:00", "Edm.DateTimeOffset"),
        toInternal("2025-03-07T23:30:00", "Edm.Date"),
      ]));`;
    for (const TZ of [
      "UTC",
      "Europe/Athens",
      "America/Los_Angeles",
      "Asia/Tokyo",
    ]) {
      const out = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        { env: { ...process.env, TZ }, encoding: "utf8" },
      );
      assert.deepEqual(
        JSON.parse(out),
        ["2025-03-07", "2025-03-07T10:00:00.000Z", "2025-03-07"],
        TZ,
      );
    }
  });

  it("an offset or a V2 /Date(ms)/ still works", () => {
    assert.equal(
      toInternal("2025-01-01T10:00:00+05:00", "Edm.DateTimeOffset"),
      "2025-01-01T05:00:00.000Z",
    );
    assert.equal(toInternal("/Date(1736035200000)/", "Edm.Date"), "2025-01-05");
    assert.equal(
      toInternal("2025-01-01", "Edm.DateTimeOffset"),
      "2025-01-01T00:00:00.000Z",
    );
  });

  it("an invalid Date object -> 400", () => {
    rejects(new Date(NaN), "Edm.DateTimeOffset");
  });

  it("SAP's initial and final dates, 0001-01-01 and 9999-12-31", () => {
    assert.equal(toInternal("0001-01-01", "Edm.Date"), "0001-01-01");
    assert.equal(
      toInternal("0001-01-01T00:00:00Z", "Edm.DateTimeOffset"),
      "0001-01-01T00:00:00.000Z",
    );
    assert.equal(toInternal("9999-12-31", "Edm.Date"), "9999-12-31");
  });

  it("a time of day out of range -> 400", () => {
    rejects("24:00:00", "Edm.TimeOfDay");
    rejects("99:99", "Edm.TimeOfDay");
    rejects("10:60:00", "Edm.TimeOfDay");
    rejects("PT25H", "Edm.TimeOfDay");
    assert.equal(toInternal("23:59:59.999", "Edm.TimeOfDay"), "23:59:59.999");
    assert.equal(toInternal("PT10H30M", "Edm.TimeOfDay"), "10:30:00");
  });
});

describe("text types are checked against their format", () => {
  it("a GUID", () => {
    assert.equal(
      toInternal("01234567-89AB-cdef-0123-456789abcdef", "Edm.Guid"),
      "01234567-89AB-cdef-0123-456789abcdef",
    );
    rejects("not-a-guid", "Edm.Guid");
    rejects("01234567-89ab-cdef-0123-456789abcde", "Edm.Guid");
  });

  it("a duration", () => {
    assert.equal(toInternal("P1DT2H", "Edm.Duration"), "P1DT2H");
    assert.equal(toInternal("-PT0.5S", "Edm.Duration"), "-PT0.5S");
    rejects("garbage", "Edm.Duration");
    rejects("P", "Edm.Duration");
    rejects("PT", "Edm.Duration");
  });

  it("binary, base64 or base64url", () => {
    assert.equal(toInternal("SGVsbG8=", "Edm.Binary"), "SGVsbG8=");
    assert.equal(toInternal("SGVsbG8_-w", "Edm.Binary"), "SGVsbG8_-w");
    rejects("!!!notbase64", "Edm.Binary");
  });
});

describe("decimals are checked against Precision and Scale", () => {
  const amount = prop("Edm.Decimal", { precision: "5", scale: "2" });

  it("fits -> kept as written", () => {
    assert.equal(propToInternal("123.45", amount), "123.45");
    assert.equal(propToInternal("-0.5", amount), "-0.5");
    assert.equal(propToInternal(12, amount), "12");
  });

  it("too many digits, or too many after the point -> 400", () => {
    for (const v of ["1234.5", "123456", "1.234"])
      assert.throws(() => propToInternal(v, amount), /InvalidValue|Invalid/, v);
  });

  it("Scale=variable takes any number of fraction digits, up to Precision", () => {
    const variable = prop("Edm.Decimal", { precision: "5", scale: "variable" });
    assert.equal(propToInternal("1.2345", variable), "1.2345");
    assert.throws(() => propToInternal("1.23456", variable));
  });

  it("an exponent or a value no number can hold -> 400; text kept in a form JSON can carry", () => {
    rejects("1e400", "Edm.Decimal");
    assert.equal(toInternal("1e3", "Edm.Decimal"), "1000");
    assert.equal(toInternal("+5", "Edm.Decimal"), "5");
    assert.equal(toInternal(".5", "Edm.Decimal"), "0.5");
    assert.equal(toInternal("5.", "Edm.Decimal"), "5");
    assert.equal(toInternal("12.50", "Edm.Decimal"), "12.50");
    assert.equal(toInternal("1e-3", "Edm.Decimal"), "0.001");
    assert.equal(toInternal("-1.5e-2", "Edm.Decimal"), "-0.015");
  });
});

describe("Int64 and Decimal keep every digit in V4 JSON", () => {
  let s: TestServer;
  before(async () => {
    s = await start(EDM_TYPES);
    const r = await send("POST", `${s.v4}/Values`, {
      ID: 1,
      Big: "9007199254740993",
      Amount: "12345678901234567890.12",
      Price: "1.50",
    });
    assert.equal(r.status, 201);
  });
  after(() => s.close());

  it("without IEEE754Compatible: numbers, with the stored digits", async () => {
    const res = await fetch(`${s.v4}/Values(1)?$select=Big,Amount,Price`);
    const text = await res.text();
    assert.match(text, /"Big":9007199254740993\b/);
    assert.match(text, /"Amount":12345678901234567890\.12\b/);
    assert.match(text, /"Price":1\.50\b/);
  });

  it("with IEEE754Compatible=true: strings, as before", async () => {
    const r = await get(`${s.v4}/Values(1)?$select=Big,Amount`, {
      accept: "application/json;IEEE754Compatible=true",
    });
    assert.deepEqual(
      [r.body.Big, r.body.Amount],
      ["9007199254740993", "12345678901234567890.12"],
    );
  });

  it("a write that doesn't fit Precision and Scale -> 400 InvalidValue, nothing stored", async () => {
    const r = await send("PATCH", `${s.v4}/Values(1)`, { Price: "1234.5" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "InvalidValue");
    const after = await get(`${s.v4}/Values(1)?$select=Price`, {
      accept: "application/json;IEEE754Compatible=true",
    });
    assert.equal(after.body.Price, "1.50");
  });
});

describe("a JSON data file's numbers keep every digit", () => {
  let s: TestServer;
  before(async () => {
    s = await start(EDM_TYPES);
  });
  after(() => s.close());

  it("an Int64 or Decimal written as a bare number, as a V4 service without IEEE754Compatible sends it", async () => {
    const r = await get(`${s.v4}/Values(2)?$select=Big,Amount,Price`, {
      accept: "application/json;IEEE754Compatible=true",
    });
    assert.deepEqual(
      [r.body.Big, r.body.Amount, r.body.Price],
      ["9007199254740993", "12345678901234567890.12", "1.50"],
    );
  });
});
