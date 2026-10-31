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

import type { PrimitiveValue, Property, PropertyValue } from "./model.ts";
import { HttpError } from "./query.ts";

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

// A value as text that tells any two values apart, for grouping and counting distinct ones:
// JSON, but with INF, -INF and NaN, which JSON.stringify would all write as null, kept apart
function distinctKey(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    specialFloat(v) ? { $float: specialFloat(v) } : v,
  );
}

// A value that doesn't fit its type is a 400: storing it anyway would serve it back as null
// or as something the type can't hold.
function invalid(value: unknown, type: string): HttpError {
  return new HttpError(400, `Invalid ${type} value: ${value}`, "InvalidValue");
}

// Any inbound value (CSV cell, JSON body field, parsed URL literal) -> internal.
function toInternal(value: unknown, type: string): PrimitiveValue {
  if (value === null || value === undefined || value === "") return null;
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
      const n =
        typeof value === "string" && value.trim() === "" ? NaN : Number(value);
      const [min, max] = INTEGER_RANGES[type];
      if (!Number.isInteger(n) || n < min || n > max)
        throw invalid(value, type);
      return n;
    }
    case "Edm.Double":
    case "Edm.Single": {
      if (typeof value === "string" && Object.hasOwn(SPECIAL_FLOATS, value))
        return SPECIAL_FLOATS[value];
      const n =
        typeof value === "string" && value.trim() === "" ? NaN : Number(value);
      if (Number.isNaN(n)) throw invalid(value, type);
      return n;
    }
    case "Edm.Int64": {
      const s = String(value).trim();
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
      if ((m = s.match(V2_TIME))) {
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
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
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
  if (value === null || value === undefined || value === "")
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
      out[p.name] = propToInternal(fields[p.name], p);
    return out;
  }
  if (prop.enumType) return String(value);
  const internal = toInternal(value, prop.elementType || prop.type);
  if ((prop.elementType || prop.type) === "Edm.Decimal" && internal !== null)
    checkDecimalFacets(String(internal), prop);
  return internal;
}

function toIsoDateTime(value: unknown, type: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw invalid(value, type);
    return value.toISOString();
  }
  const s = String(value).trim();
  const v2 = s.match(V2_DATE);
  if (v2) {
    const d = new Date(Number(v2[1]));
    if (Number.isNaN(d.getTime())) throw invalid(value, type);
    return d.toISOString();
  }
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
  // A date's own day, whatever its time; a zone shifts a timestamp to UTC
  if (type === "Edm.Date" && !zone) return `${y}-${mo}-${d}`;
  const offset =
    !zone || /^z$/i.test(zone)
      ? 0
      : (zone[0] === "-" ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return new Date(utc - offset * 60000).toISOString();
}

// Internal -> value comparable in $filter / $orderby (numbers for numeric types, ms for
// timestamps; dates and times compare correctly as strings).
// Other values are compared as they are.
function toComparable(
  value: unknown,
  type: string | null | undefined,
): PrimitiveValue {
  if (value === null || value === undefined) return null;
  if (type && isNumericType(type)) return Number(value);
  if (type === "Edm.DateTimeOffset")
    return new Date(value as string | number).getTime();
  if (type === "Edm.Date") return String(value).slice(0, 10);
  if (type === "Edm.Duration") return durationMillis(String(value));
  return value as PrimitiveValue;
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
  propToInternal,
  toComparable,
  toMillis,
  timeOfDayToV2,
  isNumericType,
  isIntegerType,
  specialFloat,
  distinctKey,
};
