// Mock rows for the entity sets that have no seed file, generated from the model alone.
//
// The data is deterministic: each entity set's random numbers are seeded from its name, so
// every restart (and every CI run) sees the same rows. What makes it usable, not just random:
//   - values fit their property: MaxLength, Precision and Scale, enum members, complex types
//   - property names pick plausible values: *Currency -> EUR, *Email -> an address, ...
//   - the values that go together agree: a row's city, postal code, region, country,
//     currency, language and company code come from one location, its product and unit
//     from one product (see Anchors)
//   - foreign keys hold the keys of real rows, so navigation and $expand return something.
//     When the foreign key is part of the key (an order's items), the rest of the key counts
//     up per parent: items 00010, 00020 of one order, 00010 of the next (an item number
//     counts by 10, as SAP's do; see isItemNumber).
//   - items agree with their header: they take its currency, and its total is the sum of
//     theirs, when it's clear which properties those are (see itemsAgree)
//
// Values are produced in the store's internal representation (see types.ts).

import type {
  EntityType,
  LinkSet,
  Model,
  PrimitiveValue,
  Property,
  PropertyValue,
  Row,
} from "./model.ts";

// A seeded random number generator, uniform in [0, 1)
type Rng = () => number;

// What a value is generated for: the property, the set's generator, the row's number (1..),
// the entity or complex type's name and what the metadata says its properties are, and the
// row's anchors
interface Ctx {
  prop: Property;
  rng: Rng;
  index: number;
  typeName: string;
  measures: Measures;
  anchors: Anchors;
}

// A type's properties that the metadata marks as the currency of an amount, the unit of a
// quantity, or a quantity (see measure in model.ts); sap:semantics marks a currency or unit
// code on its own
interface Measures {
  currencies: Set<string>;
  units: Set<string>;
  quantities: Set<string>;
}

// A place, and what goes with it. postal is the place's format: # is a random digit, @ a
// random letter. Company codes in the style of SAP Best Practices (1010 Germany, 1710 United
// States); language is SAP's language key.
interface Location {
  city: string;
  postal: string;
  region: string;
  regionName: string;
  country: string;
  countryName: string;
  currency: string;
  language: string;
  companyCode: string;
}

// A product, and its unit of measure. price is the usual range of its unit price; integral
// units are counted (5 PC), the others measured (41.650 L).
interface Product {
  name: string;
  unit: string;
  price: [number, number];
  integral: boolean;
}

// A row's location, product and date, each picked when a property first asks for it, so
// every location-like and product-like property of the row (complex members included)
// agrees, and its dates are in order (see DATE_ROLES). The date is in ms.
interface Anchors {
  location(): Location;
  product(): Product;
  date(): number;
}

// "props of set hold principalProps of principal" (see foreignKeys)
interface ForeignKey {
  set: string;
  props: string[];
  principal: string;
  principalProps: string[];
}

const DAY = 24 * 60 * 60 * 1000;
const QUARTER_HOUR = 15 * 60 * 1000;
// Dates fall in 2025, not "the last year", so the data does not change over time
const DATE_FROM = Date.UTC(2025, 0, 1);

const COMPANIES = [
  "Acme Components",
  "Nordic Steel",
  "Globex Industries",
  "Initech Systems",
  "Umbrella Supplies",
  "Stark Manufacturing",
  "Wayne Logistics",
  "Soylent Foods",
  "Hooli Electronics",
  "Vandelay Imports",
];
const DE = {
  country: "DE",
  countryName: "Germany",
  currency: "EUR",
  language: "DE",
  companyCode: "1010",
};
const US = {
  country: "US",
  countryName: "United States",
  currency: "USD",
  language: "EN",
  companyCode: "1710",
};
const GB = {
  country: "GB",
  countryName: "United Kingdom",
  currency: "GBP",
  language: "EN",
  companyCode: "1110",
};
const FR = {
  country: "FR",
  countryName: "France",
  currency: "EUR",
  language: "FR",
  companyCode: "1210",
};
const LOCATIONS: Location[] = [
  {
    ...DE,
    city: "Walldorf",
    postal: "69###",
    region: "BW",
    regionName: "Baden-Württemberg",
  },
  {
    ...DE,
    city: "Berlin",
    postal: "10###",
    region: "BE",
    regionName: "Berlin",
  },
  {
    ...DE,
    city: "Munich",
    postal: "80###",
    region: "BY",
    regionName: "Bavaria",
  },
  {
    ...DE,
    city: "Hamburg",
    postal: "20###",
    region: "HH",
    regionName: "Hamburg",
  },
  {
    ...US,
    city: "Palo Alto",
    postal: "943##",
    region: "CA",
    regionName: "California",
  },
  {
    ...US,
    city: "New York",
    postal: "100##",
    region: "NY",
    regionName: "New York",
  },
  {
    ...US,
    city: "Chicago",
    postal: "606##",
    region: "IL",
    regionName: "Illinois",
  },
  {
    ...GB,
    city: "London",
    postal: "EC#A #@@",
    region: "ENG",
    regionName: "England",
  },
  {
    ...GB,
    city: "Manchester",
    postal: "M# #@@",
    region: "ENG",
    regionName: "England",
  },
  {
    ...FR,
    city: "Paris",
    postal: "750##",
    region: "IDF",
    regionName: "Île-de-France",
  },
  {
    ...FR,
    city: "Lyon",
    postal: "690##",
    region: "ARA",
    regionName: "Auvergne-Rhône-Alpes",
  },
  {
    city: "Madrid",
    postal: "280##",
    region: "MD",
    regionName: "Madrid",
    country: "ES",
    countryName: "Spain",
    currency: "EUR",
    language: "ES",
    companyCode: "1310",
  },
  {
    city: "Milan",
    postal: "201##",
    region: "MI",
    regionName: "Lombardy",
    country: "IT",
    countryName: "Italy",
    currency: "EUR",
    language: "IT",
    companyCode: "1410",
  },
  {
    city: "Amsterdam",
    postal: "10## @@",
    region: "NH",
    regionName: "North Holland",
    country: "NL",
    countryName: "Netherlands",
    currency: "EUR",
    language: "NL",
    companyCode: "1510",
  },
  {
    city: "Zurich",
    postal: "80##",
    region: "ZH",
    regionName: "Zurich",
    country: "CH",
    countryName: "Switzerland",
    currency: "CHF",
    language: "DE",
    companyCode: "1610",
  },
  {
    city: "Tokyo",
    postal: "1##-####",
    region: "13",
    regionName: "Tokyo",
    country: "JP",
    countryName: "Japan",
    currency: "JPY",
    language: "JA",
    companyCode: "1810",
  },
];
const PRODUCTS: Product[] = [
  { name: "Steel Bracket", unit: "PC", price: [2, 20], integral: true },
  { name: "Aluminum Housing", unit: "PC", price: [15, 80], integral: true },
  { name: "Copper Wire", unit: "M", price: [0.5, 4], integral: false },
  { name: "Hex Bolt M8", unit: "PC", price: [0.1, 2], integral: true },
  { name: "Rubber Gasket", unit: "PC", price: [0.5, 5], integral: true },
  { name: "Circuit Board", unit: "EA", price: [20, 150], integral: true },
  { name: "Hydraulic Pump", unit: "EA", price: [300, 2500], integral: true },
  { name: "Ball Bearing", unit: "PC", price: [3, 40], integral: true },
  { name: "LED Panel", unit: "EA", price: [40, 300], integral: true },
  { name: "Safety Valve", unit: "EA", price: [50, 400], integral: true },
  { name: "Hydraulic Oil", unit: "L", price: [3, 15], integral: false },
  { name: "Steel Sheet", unit: "KG", price: [1, 6], integral: false },
];
const FIRST_NAMES = [
  "Anna",
  "Ben",
  "Clara",
  "David",
  "Elena",
  "Felix",
  "Grace",
  "Hugo",
  "Iris",
  "Jonas",
];
const LAST_NAMES = [
  "Schmidt",
  "Miller",
  "Rossi",
  "Dubois",
  "Novak",
  "Jensen",
  "Garcia",
  "Kowalski",
  "Tanaka",
  "Silva",
];
const STREETS = [
  "Main Street",
  "Market Square",
  "Station Road",
  "Park Avenue",
  "Harbour Lane",
];
const STATUSES = ["Open", "In Process", "Approved", "Completed", "Cancelled"];
const JOB_TITLES = [
  "Sales Manager",
  "Buyer",
  "Accountant",
  "Purchasing Agent",
  "Sales Representative",
  "Owner",
];
const WORDS = [
  "standard",
  "delivery",
  "urgent",
  "quality",
  "checked",
  "spare",
  "part",
  "bulk",
  "order",
  "replacement",
  "maintenance",
  "service",
  "annual",
  "contract",
  "sample",
];

// --- Randomness ---------------------------------------------------------------------------

// FNV-1a: a string -> 32-bit seed
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// mulberry32: a small seeded generator, uniform in [0, 1)
function random(seed: string): Rng {
  let a = hash(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, n: number) => Math.floor(rng() * n); // 0 .. n-1
const pick = <T>(rng: Rng, list: T[]): T => list[int(rng, list.length)];
const pad = (n: number, width: number) => String(n).padStart(width, "0");

const measuresOfType = new WeakMap<Record<string, Property>, Measures>();
function measuresOf(properties: Record<string, Property>): Measures {
  let m = measuresOfType.get(properties);
  if (m) return m;
  m = { currencies: new Set(), units: new Set(), quantities: new Set() };
  for (const p of Object.values(properties)) {
    if (p.measure?.currency) m.currencies.add(p.measure.currency);
    if (p.measure?.unit) {
      m.units.add(p.measure.unit);
      m.quantities.add(p.name);
    }
    if (p.sap.semantics === "currency-code") m.currencies.add(p.name);
    if (p.sap.semantics === "unit-of-measure") m.units.add(p.name);
  }
  measuresOfType.set(properties, m);
  return m;
}

// A new row's anchors: nothing is picked until a property asks. The date grows with the row,
// row index of count, across the year, a few days either way: documents made later have
// higher numbers, as an SAP number range assigns them.
function anchors(rng: Rng, index: number, count: number): Anchors {
  let location: Location | undefined;
  let product: Product | undefined;
  let date: number | undefined;
  return {
    location: () => (location ??= pick(rng, LOCATIONS)),
    product: () => (product ??= pick(rng, PRODUCTS)),
    date: () =>
      (date ??=
        DATE_FROM +
        (Math.floor(((index - 1) / Math.max(count, 1)) * 330) + int(rng, 7)) *
          DAY +
        int(rng, 24 * 4) * QUARTER_HOUR),
  };
}

// --- Foreign keys -------------------------------------------------------------------------

// Every join the model knows, as "props of set hold principalProps of principal". A
// navigation and its partner describe the same foreign key, so each is listed once.
function foreignKeys(model: Model): ForeignKey[] {
  const setsOfType: Record<string, string[]> = {};
  for (const es of Object.values(model.entitySets))
    (setsOfType[es.entityType] ||= []).push(es.name);
  const out = new Map<string, ForeignKey>();
  for (const et of Object.values(model.entityTypes)) {
    for (const nav of Object.values(et.navigations)) {
      if (nav.links) continue; // see generateLinks
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
function isKeyPart(model: Model, fk: ForeignKey): boolean {
  const type = model.entityTypes[model.entitySets[fk.set].entityType];
  return fk.principal !== fk.set && fk.props.some((p) => type.keys.includes(p));
}

// Principals before the sets whose keys depend on them. A cycle is broken wherever it is
// found; the foreign key that closes it is then filled like any non-key one.
function generationOrder(
  model: Model,
  sets: string[],
  fks: ForeignKey[],
): string[] {
  const order: string[] = [];
  const state: Record<string, string> = {};
  const visit = (set: string) => {
    if (state[set]) return;
    state[set] = "visiting";
    for (const fk of fks)
      if (fk.set === set && sets.includes(fk.principal) && isKeyPart(model, fk))
        visit(fk.principal);
    state[set] = "done";
    order.push(set);
  };
  sets.forEach(visit);
  return order;
}

function copyForeignKey(row: Row, fk: ForeignKey, parent: Row): void {
  fk.props.forEach((p, i) => (row[p] = parent[fk.principalProps[i]]));
}

// --- Values -------------------------------------------------------------------------------

// "PurchaseOrderId" -> "Purchase Order Id"
function humanize(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .trim();
}

function fit(s: string, maxLength: string | undefined): string {
  const max = Number(maxLength);
  return max > 0 && s.length > max ? s.slice(0, max) : s;
}

// A label made of a name and the row's number ("Category 3"), or digits as long as the
// property, when the label wouldn't fit whole: Extension, MaxLength 4, is 4521, not "Exte"
function labelOr(c: Ctx, name: string): string {
  const s = `${humanize(name)} ${c.index}`;
  const max = Number(c.prop.maxLength);
  if (!(max > 0 && s.length > max)) return s;
  const width = Math.min(max, 10);
  return pad(int(c.rng, 10 ** width), width);
}

// A postal code of the row's location, in its country's format: 69190, EC1A 4BX, 1012 KX
function postalCode(c: Ctx): string {
  return c.anchors
    .location()
    .postal.replace(/[#@]/g, (ch) =>
      ch === "#"
        ? String(int(c.rng, 10))
        : String.fromCharCode(65 + int(c.rng, 26)),
    );
}

// A code (at most 3 long: DE, BW) or a name (Germany), whichever the property can hold
const codeOrName = (c: Ctx, code: string, name: string) =>
  Number(c.prop.maxLength) <= 3 ? code : name;

function uuid(rng: Rng): string {
  const hex = Array.from({ length: 32 }, () => int(rng, 16).toString(16));
  hex[12] = "4";
  hex[16] = (8 + int(rng, 4)).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// A string that suits the property's name. Checked in order: the specific names come before
// the generic ones (CurrencyCode is a currency, not a code; CompanyCode is a code).
const STRING_RULES: [RegExp, (c: Ctx) => string][] = [
  [
    /e-?mail/,
    (c) =>
      `${pick(c.rng, FIRST_NAMES)}.${pick(c.rng, LAST_NAMES)}@example.com`.toLowerCase(),
  ],
  [
    /phone|mobile|fax|telephone|^tel/,
    (c) => `+1 555 01${pad(int(c.rng, 100), 2)}`,
  ],
  [/url|website|homepage/, (c) => `https://example.com/${c.index}`],
  [/photo|image|picture|path/, (c) => `/images/${c.index}.jpg`],
  [/courtesy|salutation|anrede/, (c) => pick(c.rng, ["Mr.", "Ms.", "Dr."])],
  [/currency|waers/, (c) => c.anchors.location().currency],
  [
    /country|land1/,
    (c) => {
      const l = c.anchors.location();
      return codeOrName(c, l.country, l.countryName);
    },
  ],
  [/city|town|ort01/, (c) => c.anchors.location().city],
  [/postal|zip|postcode|pstlz/, postalCode],
  [/street|address/, (c) => `${1 + int(c.rng, 200)} ${pick(c.rng, STREETS)}`],
  [
    /region|state/,
    (c) => {
      const l = c.anchors.location();
      return codeOrName(c, l.region, l.regionName);
    },
  ],
  [/language|langu|spras/, (c) => c.anchors.location().language],
  [/companycode|bukrs/, (c) => c.anchors.location().companyCode],
  [/status/, (c) => pick(c.rng, STATUSES)],
  [/unit|uom|meins/, (c) => c.anchors.product().unit],
  [/first ?name|given ?name/, (c) => pick(c.rng, FIRST_NAMES)],
  [/last ?name|surname|family ?name/, (c) => pick(c.rng, LAST_NAMES)],
  [
    /(code|id|number|no|nr)$/,
    (c) => {
      const width = Math.min(Number(c.prop.maxLength) || 6, 10);
      return pad(int(c.rng, 10 ** width), width);
    },
  ],
  [/^title$|(contact|job)title$/, (c) => pick(c.rng, JOB_TITLES)],
  [
    /contact|person|employee|user|owner|manager|by$/,
    (c) => `${pick(c.rng, FIRST_NAMES)} ${pick(c.rng, LAST_NAMES)}`,
  ],
  [
    /company|supplier|vendor|customer|partner|manufacturer|shipper|shipname/,
    (c) => pick(c.rng, COMPANIES),
  ],
  [/product|material|article/, (c) => c.anchors.product().name],
  [
    /desc|text|note|comment|remark|memo/,
    (c) => {
      const pool = [...WORDS];
      const words = Array.from(
        { length: 3 + int(c.rng, 4) },
        () => pool.splice(int(c.rng, pool.length), 1)[0],
      ).join(" ");
      return words[0].toUpperCase() + words.slice(1);
    },
  ],
  // "CategoryName" -> "Category 3"; a plain "Name" is named after its entity type
  [
    /name$|title$/,
    (c) => {
      const base = c.prop.name.replace(/(Name|Title)$/i, "");
      return labelOr(c, base || c.typeName);
    },
  ],
];

function stringValue(c: Ctx): string {
  // What the metadata says comes before what the name suggests
  if (c.measures.currencies.has(c.prop.name))
    return fit(c.anchors.location().currency, c.prop.maxLength);
  if (c.measures.units.has(c.prop.name))
    return fit(c.anchors.product().unit, c.prop.maxLength);
  const name = c.prop.name.toLowerCase();
  const rule = STRING_RULES.find(([re]) => re.test(name));
  return fit(rule ? rule[1](c) : labelOr(c, c.prop.name), c.prop.maxLength);
}

// A quantity: one the metadata gives a unit, or one named like it
const isQuantity = (c: Ctx) =>
  c.measures.quantities.has(c.prop.name) ||
  /quantity|qty|menge/.test(c.prop.name.toLowerCase());

function numberRange(name: string): [number, number] {
  if (
    /price|amount|cost|value|total|net|gross|salary|revenue|freight/.test(name)
  )
    return [10, 5000];
  if (/quantity|qty|count|stock|units|menge/.test(name)) return [1, 100];
  if (/percent|rate|discount|ratio/.test(name)) return [0, 100];
  if (/year/.test(name)) return [2015, 2025];
  return [1, 1000];
}

const INT_LIMITS: Record<string, [number, number]> = {
  "Edm.Byte": [0, 255],
  "Edm.SByte": [-128, 127],
  "Edm.Int16": [-32768, 32767],
};

function integerValue(c: Ctx, type: string): number {
  let [min, max] = numberRange(c.prop.name.toLowerCase());
  const limits = INT_LIMITS[type];
  if (limits) [min, max] = [Math.max(min, limits[0]), Math.min(max, limits[1])];
  return min + int(c.rng, max - min + 1);
}

// Scale is the number of decimals (2 when the metadata leaves it open); Precision caps the
// digits in total, so it also caps the integer part.
function decimalScale(prop: Property): number {
  return /^\d+$/.test(prop.scale ?? "") ? Number(prop.scale) : 2;
}

function decimalValue(c: Ctx): string {
  const scale = decimalScale(c.prop);
  // A price is the row's product's: a bolt costs cents, a pump thousands
  let [min, max] = /price/i.test(c.prop.name)
    ? c.anchors.product().price
    : numberRange(c.prop.name.toLowerCase());
  if (/^\d+$/.test(c.prop.precision ?? "")) {
    const top = 10 ** (Number(c.prop.precision) - scale) - 1;
    max = Math.min(max, top);
    min = Math.min(min, max);
  }
  // Pieces are counted: 5.000 PC, where litres are measured: 41.650 L
  if (isQuantity(c) && c.anchors.product().integral)
    return (min + int(c.rng, Math.floor(max - min) + 1)).toFixed(scale);
  return (min + c.rng() * (max - min)).toFixed(scale);
}

// A date's role, from its name, in order: the first that matches. A document is created,
// ordered or posted on the row's date; it's changed, shipped or due after it; an open
// validity ends on 9999-12-31, as SAP writes "no end".
const DATE_ROLES: [RegExp, (c: Ctx) => number][] = [
  [/validto|validityend|validuntil/, () => Date.UTC(9999, 11, 31)],
  [/birth/, (c) => Date.UTC(1960, 0, 1) + int(c.rng, 40 * 365) * DAY],
  [
    /creat|order|document|posting|start|begin|validfrom/,
    (c) => c.anchors.date(),
  ],
  [
    /chang|modif|required|requested|delivery|due|ship|end/,
    (c) => c.anchors.date() + (1 + int(c.rng, 30)) * DAY,
  ],
];

function dateTimeValue(c: Ctx): Date {
  const name = c.prop.name.toLowerCase();
  const role = DATE_ROLES.find(([re]) => re.test(name));
  return new Date(
    role
      ? role[1](c)
      : DATE_FROM + int(c.rng, 365) * DAY + int(c.rng, 24 * 4) * QUARTER_HOUR,
  );
}

function primitiveValue(c: Ctx, type: string): PrimitiveValue {
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

function elementValue(c: Ctx, depth: number): PropertyValue {
  const { prop } = c;
  if (prop.complexType) {
    // A complex type can contain itself; stop at some depth
    if (depth > 2) return null;
    const out: Record<string, PropertyValue> = {};
    for (const p of Object.values(prop.complexType.properties))
      out[p.name] = propertyValue(
        {
          ...c,
          prop: p,
          typeName: prop.complexType.name,
          measures: measuresOf(prop.complexType.properties),
        },
        depth + 1,
      );
    return out;
  }
  if (prop.enumType) return pick(c.rng, prop.enumType.members).name;
  return primitiveValue(c, prop.elementType || prop.type);
}

function propertyValue(c: Ctx, depth = 0): PropertyValue {
  if (!c.prop.isCollection) return elementValue(c, depth);
  return depth > 2 ? [] : [elementValue(c, depth), elementValue(c, depth)];
}

// An item's number under its parent, as SAP keys a document's items (EBELP, POSNR): a short
// string, which counts by 10, 00010, 00020, so items can be put in between
const isItemNumber = (prop: Property) =>
  prop.type === "Edm.String" &&
  [5, 6].includes(Number(prop.maxLength)) &&
  /item|position|posnr|ebelp/i.test(prop.name);

// A key value that is unique by construction: seq counts up per set (or per parent, when
// the key also holds a foreign key).
function keyValue(prop: Property, seq: number, rng: Rng): PrimitiveValue {
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
      return primitiveValue(
        {
          prop,
          rng,
          index: seq,
          typeName: "",
          measures: measuresOf({}),
          anchors: anchors(rng, seq, seq),
        },
        prop.type,
      );
  }
}

// --- Generation ---------------------------------------------------------------------------

// data: every entity set's rows so far (seeded ones included, the missing ones empty).
// Returns { <set>: rows } for each set in `sets`, `rows` per set at most: rows whose key
// comes out the same as an earlier one are dropped (a key made only of foreign keys can
// run out of combinations).
function generateData(
  model: Model,
  data: Record<string, Row[]>,
  sets: string[],
  rows: number,
): Record<string, Row[]> {
  const fks = foreignKeys(model);
  const all = { ...data };
  const rngs = Object.fromEntries(
    sets.map((set) => [set, random(`${model.container.namespace}/${set}`)]),
  );
  const typeOf = (set: string) =>
    model.entityTypes[model.entitySets[set].entityType];
  const keyFksDone = new Set<ForeignKey>();

  // Keys first, parents before children, so a child's key can hold its parent's
  for (const set of generationOrder(model, sets, fks)) {
    const type = typeOf(set);
    const rng = rngs[set];
    const keyFks = fks.filter(
      (fk) =>
        fk.set === set && isKeyPart(model, fk) && all[fk.principal]?.length,
    );
    keyFks.forEach((fk) => keyFksDone.add(fk));
    const seqs = new Map<string, number>();
    const seen = new Set<string>();
    const out: Row[] = [];
    for (let i = 0; i < rows; i++) {
      const row: Row = {};
      for (const fk of keyFks)
        copyForeignKey(row, fk, pick(rng, all[fk.principal]));
      const parent = JSON.stringify(type.keys.map((k) => row[k]));
      const seq = (seqs.get(parent) || 0) + 1;
      seqs.set(parent, seq);
      for (const k of type.keys)
        if (!(k in row))
          row[k] = keyValue(
            type.properties[k],
            keyFks.length && isItemNumber(type.properties[k]) ? seq * 10 : seq,
            rng,
          );
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
      const rowAnchors = anchors(rngs[set], i + 1, all[set].length);
      for (const prop of Object.values(type.properties)) {
        if (prop.name in row) continue;
        row[prop.name] = propertyValue({
          prop,
          rng: rngs[set],
          index: i + 1,
          typeName: type.name,
          measures: measuresOf(type.properties),
          anchors: rowAnchors,
        });
      }
    });
  }

  // Then the foreign keys outside the key, which may point anywhere, including at the same
  // set. One that overlaps the key and was not filled above (a cycle, or a set pointing at
  // itself) is left as generated: copying into it could make two keys the same.
  for (const fk of fks) {
    if (
      keyFksDone.has(fk) ||
      !sets.includes(fk.set) ||
      !all[fk.principal]?.length
    )
      continue;
    if (fk.props.some((p) => typeOf(fk.set).keys.includes(p))) continue;
    for (const row of all[fk.set])
      copyForeignKey(row, fk, pick(rngs[fk.set], all[fk.principal]));
  }

  // Last, items agree with their header
  for (const fk of fks)
    if (isKeyPart(model, fk) && sets.includes(fk.set))
      itemsAgree(model, all, fk, sets.includes(fk.principal));

  return Object.fromEntries(sets.map((set) => [set, all[set]]));
}

// --- Headers and items --------------------------------------------------------------------

const NUMBER_TYPES = ["Edm.Decimal", "Edm.Double", "Edm.Single"];
const isNumber = (p: Property) => NUMBER_TYPES.includes(p.type);

// The one property of props that matches, or undefined when none or several do
function only(
  props: Property[],
  test: (p: Property) => boolean,
): Property | undefined {
  const found = props.filter(test);
  return found.length === 1 ? found[0] : undefined;
}

// What an item adds to its header's total: its price times its quantity, or its amount;
// undefined when its type doesn't say which properties those are, unambiguously
function lineValue(item: EntityType): ((row: Row) => number) | undefined {
  const props = Object.values(item.properties).filter(
    (p) => !item.keys.includes(p.name),
  );
  const measures = measuresOf(item.properties);
  const price = only(props, (p) => isNumber(p) && /price/i.test(p.name));
  const quantity = only(
    props,
    (p) =>
      isNumber(p) &&
      (measures.quantities.has(p.name) || /quantity|qty|menge/i.test(p.name)),
  );
  if (price && quantity)
    return (row) => Number(row[price.name]) * Number(row[quantity.name]);
  const amount = only(
    props,
    (p) => isNumber(p) && /amount|value|total/i.test(p.name),
  );
  if (amount) return (row) => Number(row[amount.name]);
}

// A header's total: its one amount named like a total (TotalAmount, NetValue, GrossAmount)
function headerTotal(header: EntityType): Property | undefined {
  return only(
    Object.values(header.properties),
    (p) => isNumber(p) && /^(total|net|gross).*(amount|value)$/i.test(p.name),
  );
}

// A sum, in the store's form of the property's type; undefined when it doesn't fit the
// property's Precision
function totalValue(prop: Property, sum: number): PrimitiveValue | undefined {
  if (prop.type !== "Edm.Decimal") return Math.round(sum * 100) / 100;
  const scale = decimalScale(prop);
  const text = sum.toFixed(scale);
  if (
    /^\d+$/.test(prop.precision ?? "") &&
    text.replace(/\D/g, "").replace(/^0+(?=\d)/, "").length >
      Number(prop.precision)
  )
    return undefined;
  return text;
}

// The items of a header (fk: their foreign key, part of their key) agree with it: they take
// its currency, in the currency properties both have, and, when the header was generated
// too (generated, its total can be changed), its total is the sum of theirs. Only when it's
// clear which properties those are (see lineValue, headerTotal); a header with no items
// keeps its total.
function itemsAgree(
  model: Model,
  all: Record<string, Row[]>,
  fk: ForeignKey,
  headerGenerated: boolean,
): void {
  const typeOf = (set: string) =>
    model.entityTypes[model.entitySets[set].entityType];
  const header = typeOf(fk.principal);
  const item = typeOf(fk.set);
  const itemMeasures = measuresOf(item.properties);
  const currencies = Object.values(item.properties).filter(
    (p) =>
      p.name in header.properties &&
      !fk.props.includes(p.name) &&
      (itemMeasures.currencies.has(p.name) ||
        (p.type === "Edm.String" && /currency|waers/i.test(p.name))),
  );
  const line = lineValue(item);
  const total = headerGenerated ? headerTotal(header) : undefined;
  const keyOf = (row: Row, props: string[]) =>
    JSON.stringify(props.map((p) => row[p]));
  const headers = new Map(
    (all[fk.principal] ?? []).map((h) => [keyOf(h, fk.principalProps), h]),
  );
  const sums = new Map<Row, number>();
  for (const row of all[fk.set]) {
    const h = headers.get(keyOf(row, fk.props));
    if (!h) continue;
    for (const p of currencies) row[p.name] = h[p.name];
    if (line && total) sums.set(h, (sums.get(h) ?? 0) + line(row));
  }
  if (total)
    for (const [h, sum] of sums) {
      const value = totalValue(total, sum);
      if (value !== undefined) h[total.name] = value;
    }
}

// The rows of a link set without a data file (see linkSet in navigations.ts): each row of its
// first end linked to up to three of the second's, never to itself
function generateLinks(
  model: Model,
  data: Record<string, Row[]>,
  set: LinkSet,
): Row[] {
  const rng = random(`${model.container.namespace}/${set.name}`);
  const [from, to] = set.ends;
  const targets = data[to.set] ?? [];
  const links: Row[] = [];
  for (const row of data[from.set] ?? []) {
    const pool = targets.filter((t) => t !== row);
    for (let n = int(rng, 4); n > 0 && pool.length; n--) {
      const target = pool.splice(int(rng, pool.length), 1)[0];
      const link: Row = {};
      from.columns.forEach((c, i) => (link[c] = row[from.keys[i]]));
      to.columns.forEach((c, i) => (link[c] = target[to.keys[i]]));
      links.push(link);
    }
  }
  return links;
}

export { generateData, generateLinks, foreignKeys };
export type { ForeignKey };
