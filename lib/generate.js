// Mock rows for the entity sets that have no seed file, generated from the model alone.
//
// The data is deterministic: each entity set's random numbers are seeded from its name, so
// every restart (and every CI run) sees the same rows. What makes it usable, not just random:
//   - values fit their property: MaxLength, Precision and Scale, enum members, complex types
//   - property names pick plausible values: *Currency -> EUR, *Email -> an address, ...
//   - foreign keys hold the keys of real rows, so navigation and $expand return something.
//     When the foreign key is part of the key (an order's items), the rest of the key counts
//     up per parent: items 0001, 0002 of one order, 0001 of the next.
//
// Values are produced in the store's internal representation (see types.js).

const DAY = 24 * 60 * 60 * 1000;
// Dates fall in 2025, not "the last year", so the data does not change over time
const DATE_FROM = Date.UTC(2025, 0, 1);

const COMPANIES = ["Acme Components", "Nordic Steel", "Globex Industries", "Initech Systems", "Umbrella Supplies",
  "Stark Manufacturing", "Wayne Logistics", "Soylent Foods", "Hooli Electronics", "Vandelay Imports"];
const PRODUCTS = ["Steel Bracket", "Aluminum Housing", "Copper Wire", "Hex Bolt M8", "Rubber Gasket",
  "Circuit Board", "Hydraulic Pump", "Ball Bearing", "LED Panel", "Safety Valve"];
const FIRST_NAMES = ["Anna", "Ben", "Clara", "David", "Elena", "Felix", "Grace", "Hugo", "Iris", "Jonas"];
const LAST_NAMES = ["Schmidt", "Miller", "Rossi", "Dubois", "Novak", "Jensen", "Garcia", "Kowalski", "Tanaka", "Silva"];
const CITIES = ["Berlin", "London", "Paris", "Madrid", "Rome", "Vienna", "Amsterdam", "Stockholm", "Warsaw", "Lisbon"];
const COUNTRIES = [["DE", "Germany"], ["GB", "United Kingdom"], ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"],
  ["US", "United States"], ["JP", "Japan"], ["NL", "Netherlands"]];
const STREETS = ["Main Street", "Market Square", "Station Road", "Park Avenue", "Harbour Lane"];
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "JPY"];
const STATUSES = ["Open", "In Process", "Approved", "Completed", "Cancelled"];
const UNITS = ["EA", "PC", "KG", "L", "M"];
const LANGUAGES = ["EN", "DE", "FR", "ES"];
const JOB_TITLES = ["Sales Manager", "Buyer", "Accountant", "Purchasing Agent", "Sales Representative", "Owner"];
const REGIONS = ["North", "South", "East", "West", "Central"];
const WORDS = ["standard", "delivery", "urgent", "quality", "checked", "spare", "part", "bulk", "order",
  "replacement", "maintenance", "service", "annual", "contract", "sample"];

// --- Randomness ---------------------------------------------------------------------------

// FNV-1a: a string -> 32-bit seed
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// mulberry32: a small seeded generator, uniform in [0, 1)
function random(seed) {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng, n) => Math.floor(rng() * n); // 0 .. n-1
const pick = (rng, list) => list[int(rng, list.length)];
const pad = (n, width) => String(n).padStart(width, "0");

// --- Foreign keys -------------------------------------------------------------------------

// Every join the model knows, as "props of set hold principalProps of principal". A
// navigation and its partner describe the same foreign key, so each is listed once.
function foreignKeys(model) {
  const setsOfType = {};
  for (const es of Object.values(model.entitySets)) (setsOfType[es.entityType] ||= []).push(es.name);
  const out = new Map();
  for (const et of Object.values(model.entityTypes)) {
    for (const nav of Object.values(et.navigations)) {
      for (const source of setsOfType[et.fullName] || []) {
        const fromSource = nav.dependentSide === "source";
        const fk = {
          set: fromSource ? source : nav.targetSet,
          props: nav.join.map((pair) => pair[fromSource ? 0 : 1]),
          principal: fromSource ? nav.targetSet : source,
          principalProps: nav.join.map((pair) => pair[fromSource ? 1 : 0]),
        };
        out.set(JSON.stringify(fk), fk);
      }
    }
  }
  return [...out.values()];
}

// A foreign key that is part of the dependent's key: its values have to be known before the
// rest of the key can be made unique, so the principal is generated first.
function isKeyPart(model, fk) {
  const type = model.entityTypes[model.entitySets[fk.set].entityType];
  return fk.principal !== fk.set && fk.props.some((p) => type.keys.includes(p));
}

// Principals before the sets whose keys depend on them. A cycle is broken wherever it is
// found; the foreign key that closes it is then filled like any non-key one.
function generationOrder(model, sets, fks) {
  const order = [];
  const state = {};
  const visit = (set) => {
    if (state[set]) return;
    state[set] = "visiting";
    for (const fk of fks)
      if (fk.set === set && sets.includes(fk.principal) && isKeyPart(model, fk)) visit(fk.principal);
    state[set] = "done";
    order.push(set);
  };
  sets.forEach(visit);
  return order;
}

function copyForeignKey(row, fk, parent) {
  fk.props.forEach((p, i) => (row[p] = parent[fk.principalProps[i]]));
}

// --- Values -------------------------------------------------------------------------------

// "PurchaseOrderId" -> "Purchase Order Id"
function humanize(name) {
  return name
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .trim();
}

function fit(s, maxLength) {
  const max = Number(maxLength);
  return max > 0 && s.length > max ? s.slice(0, max) : s;
}

function uuid(rng) {
  const hex = Array.from({ length: 32 }, () => int(rng, 16).toString(16));
  hex[12] = "4";
  hex[16] = (8 + int(rng, 4)).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// A string that suits the property's name. Checked in order: the specific names come before
// the generic ones (CurrencyCode is a currency, not a code; CompanyCode is a code).
const STRING_RULES = [
  [/e-?mail/, (c) => `${pick(c.rng, FIRST_NAMES)}.${pick(c.rng, LAST_NAMES)}@example.com`.toLowerCase()],
  [/phone|mobile|fax|telephone|^tel/, (c) => `+1 555 01${pad(int(c.rng, 100), 2)}`],
  [/url|website|homepage/, (c) => `https://example.com/${c.index}`],
  [/currency|waers/, (c) => pick(c.rng, CURRENCIES)],
  [/country|land1/, (c) => pick(c.rng, COUNTRIES)[Number(c.prop.maxLength) <= 3 ? 0 : 1]],
  [/city|town|ort01/, (c) => pick(c.rng, CITIES)],
  [/postal|zip|postcode/, (c) => String(10000 + int(c.rng, 90000))],
  [/street|address/, (c) => `${1 + int(c.rng, 200)} ${pick(c.rng, STREETS)}`],
  [/region|state/, (c) => pick(c.rng, REGIONS)],
  [/language|langu/, (c) => pick(c.rng, LANGUAGES)],
  [/status/, (c) => pick(c.rng, STATUSES)],
  [/unit|uom|meins/, (c) => pick(c.rng, UNITS)],
  [/first ?name|given ?name/, (c) => pick(c.rng, FIRST_NAMES)],
  [/last ?name|surname|family ?name/, (c) => pick(c.rng, LAST_NAMES)],
  [/(code|id|number|no|nr)$/, (c) => {
    const width = Math.min(Number(c.prop.maxLength) || 6, 10);
    return pad(int(c.rng, 10 ** width), width);
  }],
  [/^title$|(contact|job)title$/, (c) => pick(c.rng, JOB_TITLES)],
  [/contact|person|employee|user|owner|manager|by$/, (c) => `${pick(c.rng, FIRST_NAMES)} ${pick(c.rng, LAST_NAMES)}`],
  [/company|supplier|vendor|customer|partner|manufacturer|shipper/, (c) => pick(c.rng, COMPANIES)],
  [/product|material|article/, (c) => pick(c.rng, PRODUCTS)],
  [/desc|text|note|comment|remark|memo/, (c) => {
    const pool = [...WORDS];
    const words = Array.from({ length: 3 + int(c.rng, 4) }, () => pool.splice(int(c.rng, pool.length), 1)[0]).join(" ");
    return words[0].toUpperCase() + words.slice(1);
  }],
  // "CategoryName" -> "Category 3"; a plain "Name" is named after its entity type
  [/name$|title$/, (c) => {
    const base = c.prop.name.replace(/(Name|Title)$/i, "");
    return `${humanize(base || c.typeName)} ${c.index}`;
  }],
];

function stringValue(c) {
  const name = c.prop.name.toLowerCase();
  const rule = STRING_RULES.find(([re]) => re.test(name));
  const s = rule ? rule[1](c) : `${humanize(c.prop.name)} ${c.index}`;
  return fit(s, c.prop.maxLength);
}

function numberRange(name) {
  if (/price|amount|cost|value|total|net|gross|salary|revenue|freight/.test(name)) return [10, 5000];
  if (/quantity|qty|count|stock|units|menge/.test(name)) return [1, 100];
  if (/percent|rate|discount|ratio/.test(name)) return [0, 100];
  if (/year/.test(name)) return [2015, 2025];
  return [1, 1000];
}

const INT_LIMITS = {
  "Edm.Byte": [0, 255],
  "Edm.SByte": [-128, 127],
  "Edm.Int16": [-32768, 32767],
};

function integerValue(c, type) {
  let [min, max] = numberRange(c.prop.name.toLowerCase());
  const limits = INT_LIMITS[type];
  if (limits) [min, max] = [Math.max(min, limits[0]), Math.min(max, limits[1])];
  return min + int(c.rng, max - min + 1);
}

// Scale is the number of decimals (2 when the metadata leaves it open); Precision caps the
// digits in total, so it also caps the integer part.
function decimalScale(prop) {
  return /^\d+$/.test(prop.scale) ? Number(prop.scale) : 2;
}

function decimalValue(c) {
  const scale = decimalScale(c.prop);
  let [min, max] = numberRange(c.prop.name.toLowerCase());
  if (/^\d+$/.test(c.prop.precision)) {
    const top = 10 ** (Number(c.prop.precision) - scale) - 1;
    max = Math.min(max, top);
    min = Math.min(min, max);
  }
  return (min + c.rng() * (max - min)).toFixed(scale);
}

function dateTimeValue(c) {
  if (/birth/.test(c.prop.name.toLowerCase()))
    return new Date(Date.UTC(1960, 0, 1) + int(c.rng, 40 * 365) * DAY);
  return new Date(DATE_FROM + int(c.rng, 365) * DAY + int(c.rng, 24 * 4) * 15 * 60 * 1000);
}

function primitiveValue(c, type) {
  switch (type) {
    case "Edm.String":
      return stringValue(c);
    case "Edm.Boolean":
      return c.rng() < 0.5;
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
      return integerValue(c, type);
    case "Edm.Int64":
      return String(integerValue(c, type));
    case "Edm.Decimal":
      return decimalValue(c);
    case "Edm.Double":
    case "Edm.Single":
      return Number(decimalValue(c));
    case "Edm.DateTimeOffset":
      return dateTimeValue(c).toISOString();
    case "Edm.Date":
      return dateTimeValue(c).toISOString().slice(0, 10);
    case "Edm.TimeOfDay":
      return `${pad(8 + int(c.rng, 10), 2)}:${pad(int(c.rng, 4) * 15, 2)}:00`;
    case "Edm.Guid":
      return uuid(c.rng);
    case "Edm.Duration":
      return `PT${1 + int(c.rng, 8)}H`;
    default:
      // Binary, Stream, the Geography and Geometry types: nothing sensible to make up
      return null;
  }
}

function elementValue(c, depth) {
  const { prop } = c;
  if (prop.complexType) {
    // A complex type can contain itself; stop at some depth
    if (depth > 2) return null;
    const out = {};
    for (const p of Object.values(prop.complexType.properties))
      out[p.name] = propertyValue({ ...c, prop: p, typeName: prop.complexType.name }, depth + 1);
    return out;
  }
  if (prop.enumType) return pick(c.rng, prop.enumType.members).name;
  return primitiveValue(c, prop.elementType || prop.type);
}

function propertyValue(c, depth = 0) {
  if (!c.prop.isCollection) return elementValue(c, depth);
  return depth > 2 ? [] : [elementValue(c, depth), elementValue(c, depth)];
}

// A key value that is unique by construction: seq counts up per set (or per parent, when
// the key also holds a foreign key).
function keyValue(prop, seq, rng) {
  switch (prop.type) {
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
    case "Edm.Double":
    case "Edm.Single":
      return seq;
    case "Edm.Int64":
      return String(seq);
    case "Edm.Decimal":
      return seq.toFixed(decimalScale(prop));
    case "Edm.Guid":
      return uuid(rng);
    case "Edm.DateTimeOffset":
      return new Date(DATE_FROM + seq * DAY).toISOString();
    case "Edm.Date":
      return new Date(DATE_FROM + seq * DAY).toISOString().slice(0, 10);
    case "Edm.TimeOfDay":
      return `${pad(Math.floor(seq / 60) % 24, 2)}:${pad(seq % 60, 2)}:00`;
    case "Edm.String": {
      // Short string keys are zero-padded the way SAP shows document numbers: 0000000001
      const max = Number(prop.maxLength);
      return max > 0 && max <= 12 ? pad(seq, max) : String(seq);
    }
    default:
      return primitiveValue({ prop, rng, index: seq, typeName: "" }, prop.type);
  }
}

// --- Generation ---------------------------------------------------------------------------

// data: every entity set's rows so far (seeded ones included, the missing ones empty).
// Returns { <set>: rows } for each set in `sets`, `rows` per set at most: rows whose key
// comes out the same as an earlier one are dropped (a key made only of foreign keys can
// run out of combinations).
function generateData(model, data, sets, rows) {
  const fks = foreignKeys(model);
  const all = { ...data };
  const rngs = Object.fromEntries(sets.map((set) => [set, random(`${model.container.namespace}/${set}`)]));
  const typeOf = (set) => model.entityTypes[model.entitySets[set].entityType];
  const keyFksDone = new Set();

  // Keys first, parents before children, so a child's key can hold its parent's
  for (const set of generationOrder(model, sets, fks)) {
    const type = typeOf(set);
    const rng = rngs[set];
    const keyFks = fks.filter(
      (fk) => fk.set === set && isKeyPart(model, fk) && all[fk.principal]?.length,
    );
    keyFks.forEach((fk) => keyFksDone.add(fk));
    const seqs = new Map();
    const seen = new Set();
    const out = [];
    for (let i = 0; i < rows; i++) {
      const row = {};
      for (const fk of keyFks) copyForeignKey(row, fk, pick(rng, all[fk.principal]));
      const parent = JSON.stringify(type.keys.map((k) => row[k]));
      const seq = (seqs.get(parent) || 0) + 1;
      seqs.set(parent, seq);
      for (const k of type.keys) if (!(k in row)) row[k] = keyValue(type.properties[k], seq, rng);
      const key = JSON.stringify(type.keys.map((k) => row[k]));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
    all[set] = out;
  }

  // Then the other properties
  for (const set of sets) {
    const type = typeOf(set);
    all[set].forEach((row, i) => {
      for (const prop of Object.values(type.properties)) {
        if (prop.name in row) continue;
        row[prop.name] = propertyValue({ prop, rng: rngs[set], index: i + 1, typeName: type.name });
      }
    });
  }

  // Then the foreign keys outside the key, which may point anywhere, including at the same
  // set. One that overlaps the key and was not filled above (a cycle, or a set pointing at
  // itself) is left as generated: copying into it could make two keys the same.
  for (const fk of fks) {
    if (keyFksDone.has(fk) || !sets.includes(fk.set) || !all[fk.principal]?.length) continue;
    if (fk.props.some((p) => typeOf(fk.set).keys.includes(p))) continue;
    for (const row of all[fk.set]) copyForeignKey(row, fk, pick(rngs[fk.set], all[fk.principal]));
  }

  return Object.fromEntries(sets.map((set) => [set, all[set]]));
}

module.exports = { generateData };
