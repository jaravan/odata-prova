// A request's resource path, as dispatch reads it (see service.ts): its segments, and the
// keys in them.

import { toInternal } from "./types.ts";
import type { LiteralSyntax } from "./filter.ts";
import { HttpError, decodeUrl, own } from "./query.ts";
import type { EntityType, Key } from "./model.ts";

// A path segment: Name, or Name(key or parameters)
interface Segment {
  name: string;
  keyText: string | undefined;
}

// "PurchaseOrderSet('4500000001')/Items(PurchaseOrderId='4500000001',ItemPosition='0001')/$count"
// -> [{ name: "PurchaseOrderSet", keyText: "'4500000001'" }, { name: "Items", keyText: "..." }, { name: "$count" }]
// Every character is a segment's: one that isn't (Set(1)Nav, a stray parenthesis) is a 400,
// not skipped, which would read another path than the one sent.
function parseSegments(resourcePath: string): Segment[] {
  const segments: Segment[] = [];
  const re = /([^/()]+)(?:\(((?:[^()']|'(?:[^']|'')*')*)\))?(?:\/+|$)/y;
  for (let at = 0; at < resourcePath.length; at = re.lastIndex) {
    const m = re.exec(resourcePath);
    if (!m)
      throw new HttpError(
        400,
        `The resource path can't be read from "${resourcePath.slice(at)}": write Set(key)/Navigation`,
      );
    segments.push({
      name: decodeUrl(m[1], decodeURIComponent),
      keyText: m[2],
    });
  }
  return segments;
}

// "'4500000001'" or "PurchaseOrderId='4500000001',ItemPosition='0001'" -> { PurchaseOrderId, ItemPosition }
// The text is as decodePath leaves it: split on its , and =, then each value decoded, so a
// value may hold them (SO%2F2025%2F1, a%2Cb).
function parseKey(
  keyText: string | undefined,
  entityType: EntityType,
  syntax: LiteralSyntax,
): Key | undefined {
  if (keyText === undefined) return undefined;
  const parts: string[] = [];
  let cur = "",
    inStr = false;
  for (const c of keyText) {
    if (c === "'") inStr = !inStr;
    if (c === "," && !inStr) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);

  const key: Key = {};
  if (parts.length === 1 && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0].trim())) {
    if (entityType.keys.length !== 1) {
      throw new HttpError(
        400,
        `${entityType.name} has a composite key; use (Prop1=...,Prop2=...)`,
      );
    }
    const k = entityType.keys[0];
    key[k] = toInternal(
      syntax.parseLiteral(decodeUrl(parts[0], decodeURIComponent)).value,
      entityType.properties[k].type,
    );
    return key;
  }
  for (const part of parts) {
    const eq = part.indexOf("=");
    const name = decodeUrl(part.slice(0, eq).trim(), decodeURIComponent);
    const prop = own(entityType.properties, name);
    if (!prop || !entityType.keys.includes(name))
      throw new HttpError(
        400,
        `${name} is not a key property of ${entityType.name}`,
      );
    key[name] = toInternal(
      syntax.parseLiteral(decodeUrl(part.slice(eq + 1), decodeURIComponent))
        .value,
      prop.type,
    );
  }
  for (const k of entityType.keys) {
    if (!(k in key)) throw new HttpError(400, `Key property ${k} missing`);
  }
  return key;
}

export type { Segment };
export { parseSegments, parseKey };
