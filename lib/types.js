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

const { HttpError } = require("./query");

const V2_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;
const V2_TIME = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i;
const TIME_OF_DAY = /^(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/;

// V2 type -> canonical (V4) type. Everything not listed is the same in both.
const V2_TO_CANONICAL = {
  "Edm.DateTime": "Edm.DateTimeOffset",
  "Edm.Time": "Edm.TimeOfDay",
};

// Canonical type -> V2 type, for a model that came from a V4 document.
const CANONICAL_TO_V2 = {
  "Edm.Date": "Edm.DateTime",
  "Edm.TimeOfDay": "Edm.Time",
  "Edm.Duration": "Edm.String",
  "Edm.Stream": "Edm.Binary",
};

function isNumericType(type) {
  return /^Edm\.(Int16|Int32|Int64|Byte|SByte|Decimal|Double|Single)$/.test(
    type
  );
}
function isIntegerType(type) {
  return /^Edm\.(Int16|Int32|Byte|SByte)$/.test(type);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

const INT64 = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
// Edm.Double and Edm.Single spell the special values as these strings in JSON
const SPECIAL_FLOATS = { INF: Infinity, "-INF": -Infinity, NaN: NaN };

// A value that doesn't fit its type is a 400: storing it anyway would serve it back as null
// or as something the type can't hold.
function invalid(value, type) {
  return new HttpError(400, `Invalid ${type} value: ${value}`);
}

// Any inbound value (CSV cell, JSON body field, parsed URL literal) -> internal.
function toInternal(value, type) {
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
      if (!Number.isInteger(n)) throw invalid(value, type);
      return n;
    }
    case "Edm.Double":
    case "Edm.Single": {
      if (value in SPECIAL_FLOATS) return SPECIAL_FLOATS[value];
      const n =
        typeof value === "string" && value.trim() === "" ? NaN : Number(value);
      if (Number.isNaN(n)) throw invalid(value, type);
      return n;
    }
    case "Edm.Int64":
    case "Edm.Decimal": {
      const s = String(value).trim();
      if (!(type === "Edm.Int64" ? INT64 : DECIMAL).test(s))
        throw invalid(value, type);
      return s;
    }
    case "Edm.DateTimeOffset":
      return toIsoDateTime(value, type);
    case "Edm.Date":
      return toIsoDateTime(value, type).slice(0, 10);
    case "Edm.TimeOfDay": {
      const s = String(value);
      let m;
      if ((m = s.match(V2_TIME))) {
        const sec =
          m[3] === undefined
            ? "00"
            : m[3].includes(".")
            ? pad2(m[3].split(".")[0]) + "." + m[3].split(".")[1]
            : pad2(m[3]);
        return `${pad2(m[1] || 0)}:${pad2(m[2] || 0)}:${sec}`;
      }
      if ((m = s.match(TIME_OF_DAY)))
        return `${m[1]}:${m[2]}:${m[3] || "00"}${m[4] || ""}`;
      throw invalid(value, type);
    }
    default:
      return String(value);
  }
}

// A whole property value -> internal: like toInternal, plus collections (arrays), complex
// types (objects, converted field by field) and enums (kept as the member name). A CSV cell
// can hold such a value as JSON. Bad input is a 400, since it comes from a request body.
// No value is null, or an empty collection: OData never has a null collection.
function propToInternal(value, prop) {
  if (value === null || value === undefined || value === "")
    return prop.isCollection ? [] : null;
  if ((prop.isCollection || prop.complexType) && typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new HttpError(400, `${prop.name}: expected JSON, got ${value}`);
    }
  }
  if (!prop.isCollection) return elementToInternal(value, prop);
  if (!Array.isArray(value))
    throw new HttpError(400, `${prop.name}: expected an array`);
  return value.map((v) => elementToInternal(v, prop));
}

function elementToInternal(value, prop) {
  if (value === null || value === undefined) return null;
  if (prop.complexType) {
    if (typeof value !== "object" || Array.isArray(value))
      throw new HttpError(400, `${prop.name}: expected an object`);
    const out = {};
    for (const p of Object.values(prop.complexType.properties))
      out[p.name] = propToInternal(value[p.name], p);
    return out;
  }
  if (prop.enumType) return String(value);
  return toInternal(value, prop.elementType || prop.type);
}

function toIsoDateTime(value, type) {
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  const m = s.match(V2_DATE);
  if (m) return new Date(Number(m[1])).toISOString();
  // A local-looking timestamp without a zone ("2025-01-20T10:00:00") is taken as UTC, so
  // seed files and V2 datetime'...' literals round-trip without a timezone shift.
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)
    ? `${s}Z`
    : s;
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) throw invalid(value, type);
  return d.toISOString();
}

// Internal -> value comparable in $filter / $orderby (numbers for numeric types, ms for
// timestamps; dates and times compare correctly as strings).
function toComparable(value, type) {
  if (value === null || value === undefined) return null;
  if (isNumericType(type)) return Number(value);
  if (type === "Edm.DateTimeOffset") return new Date(value).getTime();
  if (type === "Edm.Date") return String(value).slice(0, 10);
  return value;
}

// "10:30:00" -> "PT10H30M00S" (how V2 serialises Edm.Time).
function timeOfDayToV2(value) {
  const m = String(value).match(TIME_OF_DAY);
  if (!m) return value;
  return `PT${m[1]}H${m[2]}M${m[3] || "00"}${m[4] || ""}S`;
}

// Milliseconds since epoch for a DateTimeOffset or Date internal value.
function toMillis(value) {
  return new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00Z` : value
  ).getTime();
}

module.exports = {
  V2_TO_CANONICAL,
  CANONICAL_TO_V2,
  toInternal,
  propToInternal,
  toComparable,
  toMillis,
  timeOfDayToV2,
  isNumericType,
  isIntegerType,
};
