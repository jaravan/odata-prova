// Common Edm types

// Property types are normalised to the OData V4 names when the metadata is parsed
// (V2 Edm.DateTime -> Edm.DateTimeOffset, or Edm.Date when sap:display-format="Date";
// Edm.Time -> Edm.TimeOfDay).
// Each property also remembers its V2 type (`v2Type`) so the V2 protocol can format it
// the way a V2 client expects.
// Everything in the store is held  in one internal representation, independent of which
// protocol wrote it:
//
//   String/Guid/Binary/Duration   string
//   Int16/Int32/Byte/SByte        number
//   Int64/Decimal                 string (kept verbatim so "12500.00" stays "12500.00")
//   Double/Single                 number
//   Boolean                       boolean
//   DateTimeOffset                ISO 8601 string, UTC
//   Date                          "YYYY-MM-DD"
//   TimeOfDay                     "HH:MM:SS[.fff]"

import type {
  EnumType,
  Model,
  PrimitiveValue,
  Property,
  PropertyValue,
} from "./model.ts";
import { HttpError, own } from "./query.ts";

const V2_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
const V2_TIME = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i;
const TIME_OF_DAY = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;
// ISO 8601, as OData writes it, plus what spreadsheets write: a space for the T, slashes in
// the date. Anything else is refused rather than left to Date's parser, which reads it in the
// server's timezone (07.03.2025 as July 3rd, a day earlier east of UTC).
const ISO_DATE_TIME =
  /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A day-time duration (CSDL has no years or months), at least one part
const DURATION =
  /^-?P(?=\d|T\d)(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;
// base64, or base64url as V4's JSON format writes it
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const INTEGER_RANGES: Record<string, [number, number]> = {
  "Edm.Byte": [0, 255],
  "Edm.SByte": [-128, 127],
  "Edm.Int16": [-32768, 32767],
  "Edm.Int32": [-2147483648, 2147483647],
};
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

// Whether an integer is a value of an integer type
function inIntegerRange(value: bigint, type: string): boolean {
  const [min, max] =
    type === "Edm.Int64" ? [INT64_MIN, INT64_MAX] : INTEGER_RANGES[type];
  return value >= min && value <= max;
}

// The most digits a decimal may have on either side of the point when its metadata doesn't
// say: HANA's and ABAP's largest, and far more than 1e400 needs to be refused
const DECIMAL_DIGITS = 38;

// V2 type -> canonical (V4) type. Everything not listed is the same in both.
const V2_TO_CANONICAL: Record<string, string> = {
  "Edm.DateTime": "Edm.DateTimeOffset",
  "Edm.Time": "Edm.TimeOfDay",
};

// Canonical type -> V2 type, for a model that came from a V4 document.
const CANONICAL_TO_V2: Record<string, string> = {
  "Edm.Date": "Edm.DateTime",
  "Edm.TimeOfDay": "Edm.Time",
  "Edm.Duration": "Edm.String",
  "Edm.Stream": "Edm.Binary",
};

function isNumericType(type: string): boolean {
  return /^Edm\.(Int16|Int32|Int64|Byte|SByte|Decimal|Double|Single)$/.test(
    type,
  );
}
function isIntegerType(type: string): boolean {
  return /^Edm\.(Int16|Int32|Byte|SByte)$/.test(type);
}

function pad2(n: string | number): string {
  return String(n).padStart(2, "0");
}

const INT64 = /^[+-]?\d+$/;
const MAX_SINGLE = 3.4028235677973366e38;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
// Edm.Double and Edm.Single spell the special values as these strings in JSON
const SPECIAL_FLOATS: Record<string, number> = {
  INF: Infinity,
  "-INF": -Infinity,
  NaN: NaN,
};

// The string for Infinity, -Infinity or NaN, the way OData writes them (JSON has no such
// numbers: JSON.stringify would write null); undefined for any other value
function specialFloat(value: unknown): string | undefined {
  if (typeof value !== "number" || Number.isFinite(value)) return undefined;
  return Number.isNaN(value) ? "NaN" : value > 0 ? "INF" : "-INF";
}

// JSON, but with INF, -INF and NaN, which JSON.stringify would all write as null, each as
// {"$float": "INF"}: no property is called $float, as OData names start with a letter or an
// underscore. So two values that differ have different text, for comparing, keying or saving.
function floatJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    specialFloat(v) ? { $float: specialFloat(v) } : v,
  );
}

// A value of a type as text, for grouping and counting distinct ones: the same for two values
// eq calls equal, however each is spelled (0.3 and 0.30), and different for any others. A
// value toComparable can't read stays itself, and isn't taken for null.
function distinctKey(value: unknown, type: string): string {
  const comparable = toComparable(value, type) ?? value ?? null;
  return floatJson(
    typeof comparable === "bigint" ? String(comparable) : comparable,
  );
}

// A number, or one as text in decimal: Number alone would also read 0x10, and blanks as 0
function numberOf(value: unknown): number {
  return typeof value !== "string" || DECIMAL.test(value.trim())
    ? Number(value)
    : NaN;
}

// A decimal as a whole number of 10^-DECIMAL_DIGITS, which compares and adds exactly;
// undefined for what isn't one (INF, or text that's no number)
function decimalUnits(value: unknown): bigint | undefined {
  let text: string;
  try {
    text = plainDecimal(value, "Edm.Decimal");
  } catch {
    return undefined;
  }
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const units = BigInt(whole + fraction.padEnd(DECIMAL_DIGITS, "0"));
  return negative ? -units : units;
}

// A decimal's place among decimals, for comparing: in halves of decimalUnits' units, so that a
// literal too long for a decimal has one too, between the two it falls between. Its digits
// aren't lost to a double, which would also be in other units.
function decimalOrder(value: unknown): bigint | number {
  const units = decimalUnits(value);
  if (units !== undefined) return units * 2n;
  const n = numberOf(value);
  if (!Number.isFinite(n)) return n; // text that's no number, or beyond any decimal
  const scale = 10n ** BigInt(DECIMAL_DIGITS);
  const m = String(value)
    .trim()
    .match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!m) return BigInt(Math.trunc(n)) * scale * 2n; // an exponent
  const [, sign, whole, fraction = ""] = m;
  const kept = fraction.slice(0, DECIMAL_DIGITS).padEnd(DECIMAL_DIGITS, "0");
  const between = /[1-9]/.test(fraction.slice(DECIMAL_DIGITS)) ? 1n : 0n;
  const order = BigInt(whole + kept) * 2n + between;
  return sign === "-" ? -order : order;
}

// A whole number of 10^-scale as a decimal's text
function decimalText(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale ? `.${digits.slice(digits.length - scale)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}

// A value as a join compares it: as text, a GUID's digits in either case, and as its property
// has it when that's known, so that 1.5 joins 1.50 and PT60M joins PT1H
function joinText(value: unknown, prop?: Property): string {
  const text = prop ? keyText(value, prop) : String(value);
  return GUID.test(text) ? text.toLowerCase() : text;
}

// A binary's bytes in hex: base64 and base64url, padded or not, are spellings of the same ones
function binaryBytes(text: string): string {
  return Buffer.from(text, "base64").toString("hex");
}

// A value that doesn't fit its type is a 400: storing it anyway would serve it back as null
// or as something the type can't hold.
function invalid(value: unknown, type: string): HttpError {
  return new HttpError(400, `Invalid ${type} value: ${value}`, "InvalidValue");
}

// Fractional seconds cut or padded to the property's Precision facet. Without a facet the
// precision is 0 (CSDL), and strict clients such as UI5's V4 model reject any fraction.
function withPrecision(
  value: PropertyValue,
  precision: string | undefined,
): string {
  // A calculated time has no facet: it's as fine as it came out
  if (precision === "as written") return String(value);
  // 12 is as fine as CSDL goes
  const digits = Math.min(Number(precision) || 0, 12);
  return String(value).replace(
    /(:\d{2})(?:\.(\d+))?(?=Z|[+-]\d{2}:\d{2}|$)/,
    (_: string, sec: string, frac: string = "") =>
      digits ? `${sec}.${frac.padEnd(digits, "0").slice(0, digits)}` : sec,
  );
}

// A key's value as text that two ways of writing it share, for finding an entity by its key.
// 1.50 and 1.5 are one Decimal, a GUID's digits have either case, and a time is as fine as
// its Precision, which is all a client gets to read and so to build a key from.
function keyText(value: unknown, prop: Property): string {
  const text = String(value);
  switch (prop.type) {
    case "Edm.Decimal": {
      const short = text.includes(".") ? text.replace(/\.?0+$/, "") : text;
      const plain = short.replace(/^(-?)0+(?=\d)/, "$1");
      return plain === "-0" ? "0" : plain;
    }
    case "Edm.Guid":
      return text.toLowerCase();
    case "Edm.DateTimeOffset":
    case "Edm.TimeOfDay":
      return withPrecision(value as PropertyValue, prop.precision);
    case "Edm.Binary":
      return binaryBytes(text);
    case "Edm.Duration":
      return String(durationMillis(text) ?? text);
    default:
      return text;
  }
}

// A number in a body with more digits than a double holds: text to the conversions, which keep
// its digits, and still a number to the check of a body's JSON types (see checkValue)
class LongNumber extends String {}

// A JSON.parse reviver for a request's body: a number with more digits than a double holds
// (9007199254740993, an Int64) is read as its text, which the property's type then reads.
// The source text is the reviver's third argument (Node 21 and later).
const keepLongNumbers = ((
  _key: string,
  value: unknown,
  context?: { source?: string },
) =>
  typeof value === "number" &&
  context?.source !== undefined &&
  context.source.replace(/e.*$|[-.]/gi, "").replace(/^0+/, "").length > 15
    ? new LongNumber(context.source)
    : value) as (key: string, value: unknown) => unknown;

// Any inbound value (CSV cell, JSON body field, parsed URL literal) -> internal.
// An empty string is a value of a string, which ABAP's blank is, and of nothing else, where
// it stays no value. (A CSV cell left empty is null: see parseCsv.)
function toInternal(value: unknown, type: string): PrimitiveValue {
  if (value === null || value === undefined) return null;
  if (value === "" && type !== "Edm.String") return null;
  switch (type) {
    case "Edm.Boolean": {
      // Any case, since spreadsheets write TRUE and FALSE
      const s = String(value).toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      throw invalid(value, type);
    }
    case "Edm.Int16":
    case "Edm.Int32":
    case "Edm.Byte":
    case "Edm.SByte": {
      const n = numberOf(value);
      const [min, max] = INTEGER_RANGES[type];
      if (!Number.isInteger(n) || n < min || n > max)
        throw invalid(value, type);
      return n;
    }
    case "Edm.Double":
    case "Edm.Single": {
      if (typeof value === "string" && Object.hasOwn(SPECIAL_FLOATS, value))
        return SPECIAL_FLOATS[value];
      const n = numberOf(value);
      // The number NaN is a literal's, and text that's no number isn't one
      if (Number.isNaN(n) && !Number.isNaN(value)) throw invalid(value, type);
      if (
        type === "Edm.Single" &&
        Number.isFinite(n) &&
        Math.abs(n) > MAX_SINGLE
      )
        throw invalid(value, type);
      return n;
    }
    case "Edm.Int64": {
      // A whole number however it's written, as the shorter integers read it
      const s = String(value).trim().replace(/\.0*$/, "");
      if (!INT64.test(s)) throw invalid(value, type);
      const n = BigInt(s);
      if (n < INT64_MIN || n > INT64_MAX) throw invalid(value, type);
      return s.replace(/^\+/, "");
    }
    case "Edm.Decimal":
      return plainDecimal(value, type);
    case "Edm.DateTimeOffset":
      return toIsoDateTime(value, type);
    case "Edm.Date":
      return toIsoDateTime(value, type).slice(0, 10);
    case "Edm.TimeOfDay": {
      const s = String(value);
      let m: RegExpMatchArray | null;
      let time: string | undefined;
      // PT alone says nothing: at least one part
      if ((m = s.match(V2_TIME)) && (m[1] ?? m[2] ?? m[3]) !== undefined) {
        const sec =
          m[3] === undefined
            ? "00"
            : m[3].includes(".")
              ? pad2(m[3].split(".")[0]) + "." + m[3].split(".")[1]
              : pad2(m[3]);
        time = `${pad2(m[1] || 0)}:${pad2(m[2] || 0)}:${sec}`;
      } else if ((m = s.match(TIME_OF_DAY)))
        time = `${m[1]}:${m[2]}:${m[3] || "00"}${m[4] || ""}`;
      // 24:00:00 is the end of a day, not a time of day
      const [h, min, sec] = (time ?? "").split(":").map(Number);
      if (time === undefined || h > 23 || min > 59 || sec >= 60)
        throw invalid(value, type);
      return time;
    }
    case "Edm.Guid":
      if (!GUID.test(String(value))) throw invalid(value, type);
      return String(value);
    case "Edm.Duration":
      if (!DURATION.test(String(value))) throw invalid(value, type);
      return String(value);
    case "Edm.Binary": {
      const s = String(value);
      if (!BASE64.test(s) || s.replace(/=+$/, "").length % 4 === 1)
        throw invalid(value, type);
      return s;
    }
    case "Edm.String":
      // Half a surrogate pair isn't text, and has no form in a URL or a header
      if (/\p{Cs}/u.test(String(value))) throw invalid(value, type);
      return String(value);
    default:
      return String(value);
  }
}

// A decimal as text JSON can carry as a number, its digits as written: "+5" -> "5", ".5" ->
// "0.5", "1e3" -> "1000" (so that V4 can write it unquoted, see toWire). One with more digits
// than any decimal holds, such as 1e400, is refused.
function plainDecimal(value: unknown, type: string): string {
  const m = String(value)
    .trim()
    .match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || !DECIMAL.test(String(value).trim())) throw invalid(value, type);
  const [, sign, int, frac = "", exp] = m;
  let digits = int + frac;
  let point = int.length + Number(exp ?? 0);
  if (Math.abs(point) > 2 * DECIMAL_DIGITS) throw invalid(value, type);
  if (point < 0) {
    digits = "0".repeat(-point) + digits;
    point = 0;
  }
  digits = digits.padEnd(point, "0");
  const whole = digits.slice(0, point).replace(/^0+(?=\d)/, "") || "0";
  // Trailing zeros the text wrote are kept (12.50 stays 12.50), ones an exponent moved aren't
  let fraction = digits.slice(point);
  if (exp !== undefined) fraction = fraction.replace(/0+$/, "");
  if (whole.length > DECIMAL_DIGITS || fraction.length > DECIMAL_DIGITS)
    throw invalid(value, type);
  return `${sign === "-" ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

// A decimal's digits against its Precision (all digits) and Scale (digits after the point):
// Precision 5 and Scale 2 hold 123.45 but not 1234.5 or 1.234. Without a Scale, or with
// Scale variable, any digits after the point fit, up to the Precision.
function checkDecimalFacets(text: string, prop: Property): void {
  const [whole, written = ""] = text.replace(/^-/, "").split(".");
  // Zeros ending it don't change the number: 1.230 fits a Scale of 2
  const fraction = written.replace(/0+$/, "");
  const precision = /^\d+$/.test(prop.precision ?? "")
    ? Number(prop.precision)
    : undefined;
  const scale = /^\d+$/.test(prop.scale ?? "") ? Number(prop.scale) : undefined;
  const significant = whole.replace(/^0+/, "").length;
  const fits =
    (scale === undefined || fraction.length <= scale) &&
    (precision === undefined ||
      significant + (scale ?? fraction.length) <= precision);
  if (!fits)
    throw new HttpError(
      400,
      `Invalid Edm.Decimal value: ${text} doesn't fit ${prop.name}'s Precision ${prop.precision ?? "-"} and Scale ${prop.scale ?? "-"}`,
      "InvalidValue",
    );
}

// A whole property value -> internal: like toInternal, plus collections (arrays), complex
// types (objects, converted field by field) and enums (kept as the member name). A CSV cell
// can hold such a value as JSON. Bad input is a 400, since it comes from a request body.
// No value is null, or an empty collection: OData never has a null collection.
function propToInternal(value: unknown, prop: Property): PropertyValue {
  if (
    value === null ||
    value === undefined ||
    (value === "" && prop.type !== "Edm.String")
  )
    return prop.isCollection ? [] : null;
  if ((prop.isCollection || prop.complexType) && typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new HttpError(
        400,
        `${prop.name}: expected JSON, got ${value}`,
        "InvalidValue",
      );
    }
  }
  if (!prop.isCollection) return elementToInternal(value, prop);
  if (!Array.isArray(value))
    throw new HttpError(400, `${prop.name}: expected an array`, "InvalidValue");
  return value.map((v) => elementToInternal(v, prop));
}

// The enum type a literal names, by its namespace or its schema's alias
function enumNamed(model: Model, name: string): EnumType | undefined {
  const dot = name.lastIndexOf(".");
  const namespace = own(model.aliases, name.slice(0, Math.max(dot, 0)));
  return own(
    model.enumTypes,
    namespace ? `${namespace}${name.slice(dot)}` : name,
  );
}

// An enum's value as its member's name, given by name or by number; several, for flags
function enumValue(value: unknown, type: EnumType): string {
  const given = String(value);
  return (type.isFlags ? given.split(",") : [given])
    .map((text) => {
      const member = type.members.find(
        (m) => m.name === text.trim() || String(m.value) === text.trim(),
      );
      if (!member) throw invalid(value, type.name);
      return member.name;
    })
    .join(",");
}

function elementToInternal(value: unknown, prop: Property): PropertyValue {
  if (value === null || value === undefined) return null;
  if (prop.complexType) {
    if (typeof value !== "object" || Array.isArray(value))
      throw new HttpError(
        400,
        `${prop.name}: expected an object`,
        "InvalidValue",
      );
    const fields = value as Record<string, unknown>;
    const out: Record<string, PropertyValue> = {};
    for (const p of Object.values(prop.complexType.properties))
      out[p.name] = propToInternal(own(fields, p.name), p);
    return out;
  }
  if (prop.enumType) return enumValue(value, prop.enumType);
  const internal = toInternal(value, prop.elementType || prop.type);
  if ((prop.elementType || prop.type) === "Edm.Decimal" && internal !== null)
    checkDecimalFacets(String(internal), prop);
  return internal;
}

// A moment as ISO 8601 text. A year outside 0000 to 9999, which a time zone can move one to,
// takes a form no literal reads, so that an entity with it as a key couldn't be found again.
function isoText(moment: Date, value: unknown, type: string): string {
  const text = Number.isNaN(moment.getTime()) ? "" : moment.toISOString();
  if (!/^\d{4}-/.test(text)) throw invalid(value, type);
  return text;
}

function toIsoDateTime(value: unknown, type: string): string {
  if (value instanceof Date) return isoText(value, value, type);
  const s = String(value).trim();
  const v2 = s.match(V2_DATE);
  if (v2) return isoText(new Date(Number(v2[1])), value, type);
  const m = s.match(ISO_DATE_TIME);
  if (!m) throw invalid(value, type);
  const [, y, mo, d, h = "00", mi = "00", sec = "00", frac = "", zone] = m;
  // Built from its parts, so that it's checked against the calendar: Date would take Feb 30
  // as Mar 2. No zone is UTC, so seed files and V2 datetime'...' literals round-trip without
  // a timezone shift.
  const [Y, M, D, H, MI, S] = [y, mo, d, h, mi, sec].map(Number);
  const ms = Math.trunc(Number(`0${frac || ".0"}`) * 1000);
  // setUTCFullYear, as Date.UTC takes years 0 to 99 as 1900 to 1999 (and 0001-01-01 is SAP's
  // initial date)
  const back = new Date(Date.UTC(2000, M - 1, D, H, MI, S, ms));
  back.setUTCFullYear(Y, M - 1, D);
  const utc = back.getTime();
  if (
    back.getUTCFullYear() !== Y ||
    back.getUTCMonth() !== M - 1 ||
    back.getUTCDate() !== D ||
    H > 23 ||
    MI > 59 ||
    S > 59
  )
    throw invalid(value, type);
  const [zoneH, zoneM] = (zone ?? "").slice(1).split(":").map(Number);
  if (zoneH > 23 || zoneM > 59) throw invalid(value, type);
  // A date's own day, whatever its time; a zone shifts a timestamp to UTC
  if (type === "Edm.Date" && !zone) return `${y}-${mo}-${d}`;
  const offset =
    !zone || /^z$/i.test(zone)
      ? 0
      : (zone[0] === "-" ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  const text = isoText(new Date(utc - offset * 60000), value, type);
  // Date holds milliseconds: a finer time keeps its digits, in the text
  return /[1-9]/.test(frac.slice(4))
    ? text.replace(/\.\d+/, frac.replace(/0+$/, ""))
    : text;
}

// Internal -> value comparable in $filter / $orderby (numbers for numeric types, ms for
// timestamps; dates and times compare correctly as strings).
// Other values are compared as they are.
function toComparable(
  value: unknown,
  type: string | null | undefined,
): PrimitiveValue | bigint {
  if (value === null || value === undefined) return null;
  // Every digit, which a double would round from 2^53 on. < and > compare a bigint with a
  // number exactly, so a literal of another numeric type compares with it too.
  if (type === "Edm.Int64" && INT64.test(String(value)))
    return BigInt(String(value));
  if (type === "Edm.Decimal") return decimalOrder(value);
  if (type && isNumericType(type)) return Number(value);
  // Hex digits, in either case
  if (type === "Edm.Guid") return String(value).toLowerCase();
  if (type === "Edm.DateTimeOffset") return momentOrder(value);
  if (type === "Edm.Date") return String(value).slice(0, 10);
  // Zeros ending a fraction don't change a time
  if (type === "Edm.TimeOfDay")
    return String(value).replace(/\.(\d*?)0*$/, (_, digits: string) =>
      digits ? `.${digits}` : "",
    );
  if (type === "Edm.Duration") return durationMillis(String(value));
  if (type === "Edm.Binary") return binaryBytes(String(value));
  return value as PrimitiveValue;
}

// A moment as a number to compare, in picoseconds so that every digit of a time counts, which
// a double's wouldn't. What isn't a moment is NaN, as Date has it.
function momentOrder(value: unknown): bigint | number {
  const ms = new Date(value as string | number).getTime();
  if (Number.isNaN(ms)) return NaN;
  const finer = typeof value === "string" && value.match(/\.\d{3}(\d+)/);
  const digits = finer ? finer[1].padEnd(9, "0").slice(0, 9) : "0";
  return BigInt(ms) * 1000000000n + BigInt(digits);
}

// The order of two values toComparable gave, neither null. NaN isn't less or greater than
// anything, and a sort that's told so of some values and not of others leaves the rest out of
// order too, so it has a place of its own: after every number, as PostgreSQL has it.
function compareValues(a: unknown, b: unknown): number {
  if (Number.isNaN(a) || Number.isNaN(b))
    return Number(Number.isNaN(a)) - Number(Number.isNaN(b));
  const [x, y] = [a as number, b as number];
  return x < y ? -1 : x > y ? 1 : 0;
}

// A day-time duration's length in ms, so that P1D sorts after PT1H; null when it isn't one
function durationMillis(text: string): number | null {
  const m = text.match(
    /^(-?)P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/,
  );
  if (!m) return null;
  const [, sign, d = 0, h = 0, min = 0, sec = 0] = m;
  const ms =
    ((Number(d) * 24 + Number(h)) * 60 + Number(min)) * 60000 +
    Number(sec) * 1000;
  return sign ? -ms : ms;
}

// "10:30:00" -> "PT10H30M00S" (how V2 serialises Edm.Time).
function timeOfDayToV2(value: string): string {
  const m = String(value).match(TIME_OF_DAY);
  if (!m) return value;
  return `PT${m[1]}H${m[2]}M${m[3] || "00"}${m[4] || ""}S`;
}

// Milliseconds since epoch for a DateTimeOffset or Date internal value.
function toMillis(value: string | number | Date): number {
  return new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00Z` : value,
  ).getTime();
}

export {
  V2_TO_CANONICAL,
  CANONICAL_TO_V2,
  toInternal,
  INT64,
  DECIMAL_DIGITS,
  decimalUnits,
  decimalText,
  joinText,
  enumNamed,
  enumValue,
  INTEGER_RANGES,
  inIntegerRange,
  LongNumber,
  keepLongNumbers,
  keyText,
  binaryBytes,
  withPrecision,
  propToInternal,
  toComparable,
  compareValues,
  toMillis,
  timeOfDayToV2,
  isNumericType,
  isIntegerType,
  specialFloat,
  distinctKey,
  floatJson,
};
