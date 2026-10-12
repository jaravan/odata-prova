// Optimistic concurrency: the entity sets whose entities carry an ETag, the ETag itself,
// and its checks.
//
// An entity set has ETags when its metadata names the properties they're made of:
// Core.OptimisticConcurrency on the set (V4, as CAP writes it for @odata.etag), or
// ConcurrencyMode="Fixed" on properties of its type (V2, as SAP Gateway writes it). V2
// documents can carry the V4 annotation too.
//
// The ETag is those properties' values, W/"<value>,<value>". The server sets them on every
// write, as CAP does for a managed modifiedAt and RAP for its last-changed timestamp, so an
// ETag goes stale when the entity changes: a timestamp moves to now, a number counts up, a
// GUID is new.
//
// A request with If-Match is checked against the entity's current ETag (or *): a stale one
// is a 412. An update or delete without one is a 428, as the OData spec has it for an entity
// set with Core.OptimisticConcurrency; an action without one runs, which the spec leaves to
// the service. A draft is checked but not required to send one.

import { randomBytes, randomUUID } from "node:crypto";
import type { Xml, Qualify } from "./metadata.ts";
import type {
  EntityType,
  Model,
  Property,
  PropertyValue,
  Row,
} from "./model.ts";
import type { RequestHeaders } from "./service.ts";
import { HttpError } from "./query.ts";

const CONCURRENCY = "Org.OData.Core.V1.OptimisticConcurrency";

const list = (x: Xml): Xml[] =>
  x === undefined ? [] : Array.isArray(x) ? x : [x];

// Sets es.concurrency for each entity set with ETags. schemas are the parsed document's;
// qualify resolves an alias (see termQualifier in metadata.ts).
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */
function parseConcurrency(
  model: Model,
  schemas: Xml[],
  qualify: Qualify,
): void {
  const container = `${model.container.namespace}.${model.container.name}`;
  const declared: Record<string, string[]> = {};
  const annotate = (setName: string, annotations: Xml) => {
    for (const a of list(annotations)) {
      if (a.Qualifier || qualify(a.Term) !== CONCURRENCY) continue;
      declared[setName] = list(a.Collection?.PropertyPath).map(String);
    }
  };
  for (const schema of schemas) {
    for (const c of schema.EntityContainer || [])
      for (const es of c.EntitySet || []) annotate(es.Name, es.Annotation);
    for (const block of list(schema.Annotations)) {
      const [path, setName, ...rest] = String(block.Target).split("/");
      if (rest.length || qualify(path) !== container) continue;
      annotate(setName, block.Annotation);
    }
  }

  for (const es of Object.values(model.entitySets)) {
    const et = model.entityTypes[es.entityType];
    const names =
      declared[es.name] ??
      Object.values(et.properties)
        .filter((p) => p.concurrency)
        .map((p) => p.name);
    const unknown = names.filter((n) => !et.properties[n]);
    if (unknown.length)
      model.warnings.push(
        `ETag ignored: ${es.name}: ${et.name} has no property ${unknown.join(", ")}`,
      );
    else if (names.length) es.concurrency = names;
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access */

// The entity's ETag, or undefined for an entity set without
function etagOf(model: Model, setName: string, row: Row): string | undefined {
  const names = model.entitySets[setName]?.concurrency;
  if (!names) return undefined;
  const values = names.map((n) =>
    // No quote inside an entity tag
    row[n] === null ? "" : String(row[n]).replace(/"/g, "%22"),
  );
  return `W/"${values.join(",")}"`;
}

// The entity tags of an If-Match header: *, or quoted tags, weak or not, separated by commas
// (which a tag may contain, so they're matched rather than split on)
function entityTags(header: string): string[] {
  return (header.match(/\*|(?:W\/)?"[^"]*"/g) || []).map((t) =>
    t.replace(/^W\//, ""),
  );
}

// Checks If-Match on a request that changes the entity (see the top of the file)
function checkIfMatch(
  model: Model,
  setName: string,
  row: Row,
  headers: RequestHeaders,
  required: boolean,
): void {
  const etag = etagOf(model, setName, row);
  if (!etag) return;
  const raw = headers["if-match"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  if (!header) {
    if (required)
      throw new HttpError(
        428,
        `${setName} uses optimistic concurrency: send the entity's ETag in If-Match`,
      );
    return;
  }
  const tags = entityTags(header);
  if (!tags.includes("*") && !tags.includes(etag.replace(/^W\//, "")))
    throw new HttpError(
      412,
      `The entity has changed since it was read: its ETag is now ${etag}`,
    );
}

// The property's next value, so the ETag changes (see the top of the file). A type without a
// next value (a time of day, a boolean) keeps its value.
function nextValue(value: PropertyValue, p: Property): PropertyValue {
  switch (p.type) {
    case "Edm.DateTimeOffset": {
      // Without fractional seconds on the wire (Precision 0), a change has to be a second
      const unit = Number(p.precision) > 0 ? 1 : 1000;
      const before = value === null ? 0 : Date.parse(String(value));
      const now = Math.floor(Date.now() / unit) * unit;
      return new Date(Math.max(now, before + unit)).toISOString();
    }
    case "Edm.Date": {
      const day = 86400000;
      const before = value === null ? 0 : Date.parse(String(value));
      const today = Math.floor(Date.now() / day) * day;
      return new Date(Math.max(today, before + day)).toISOString().slice(0, 10);
    }
    case "Edm.Byte":
    case "Edm.SByte":
    case "Edm.Int16":
    case "Edm.Int32":
      return Number(value ?? 0) + 1;
    case "Edm.Int64":
    case "Edm.Decimal":
      return String(BigInt(String(value ?? 0).split(".")[0]) + 1n);
    case "Edm.Guid":
      return randomUUID();
    case "Edm.Binary":
      return randomBytes(8).toString("base64");
    case "Edm.String": {
      const next = randomUUID().replace(/-/g, "");
      return p.maxLength && p.maxLength !== "max"
        ? next.slice(0, Number(p.maxLength))
        : next;
    }
    default:
      return value;
  }
}

// Gives the entity new values for its ETag's properties, after a write. A key property in
// the ETag keeps its value: changing it would make it another entity.
function renewETag(
  model: Model,
  setName: string,
  type: EntityType,
  row: Row,
): void {
  for (const name of model.entitySets[setName]?.concurrency || [])
    if (!type.keys.includes(name))
      row[name] = nextValue(row[name], type.properties[name]);
}

export { parseConcurrency, etagOf, checkIfMatch, renewETag };
