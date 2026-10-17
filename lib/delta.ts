// V4 delta links: a client that reads an entity set with Prefer: odata.track-changes gets an
// @odata.deltaLink with its last page, and reading that link later answers what has changed
// since: the entities added or changed, and the ones deleted, as $deletedEntity entries.
//
// A delta token stands for a copy of the entity set's rows when it was handed out, and the
// changes are what differs from it now. A copy rather than a log of the writes: rows change in
// place in many places (writes, drafts, operation rules, a $batch changeset rolled back), and
// comparing catches them all. Only the latest tokens are kept, and none across a restart: an
// older one is a 410 Gone, and the client reads the entity set again.

import { applyQuery, type QueryHost } from "./apply-query.ts";
import type { EntityType, QueryNode, Row } from "./model.ts";

// How many delta tokens are kept, per service
const KEPT = 100;

// An entity that left the client's set since its token: deleted, or changed so that it no
// longer matches the $filter or $search
export interface Removed {
  row: Row;
  reason: "deleted" | "changed";
}

class DeltaTokens {
  // Tokens from before a restart don't match, even though the counter starts over
  private epoch = Date.now().toString(36);
  private next = 1;
  private copies = new Map<string, { setName: string; rows: Row[] }>();

  // A token for the entity set's rows as they are now
  issue(setName: string, rows: Row[]): string {
    const token = `${this.epoch}-${this.next++}`;
    this.copies.set(token, { setName, rows: structuredClone(rows) });
    if (this.copies.size > KEPT)
      this.copies.delete(this.copies.keys().next().value!);
    return token;
  }

  // The rows a token stands for, or undefined for one that's unknown or no longer kept
  rows(token: string, setName: string): Row[] | undefined {
    const copy = this.copies.get(token);
    return copy?.setName === setName ? copy.rows : undefined;
  }
}

// What differs between the rows a token stands for and the current ones, for the client's
// $filter and $search: the entities that match now and are new or changed, and the ones that
// matched before and are now deleted or no longer match.
function deltaChanges(
  svc: QueryHost,
  type: EntityType,
  before: Row[],
  now: Row[],
  q: QueryNode,
): { rows: Row[]; removed: Removed[] } {
  const keyOf = (row: Row) =>
    JSON.stringify(type.keys.map((k) => String(row[k])));
  const matches = (row: Row) =>
    applyQuery(svc, [row], type, {
      expand: {},
      filter: q.filter,
      search: q.search,
    }).results.length > 0;
  const same = (a: Row, b: Row) =>
    Object.keys(type.properties).every(
      (p) => JSON.stringify(a[p]) === JSON.stringify(b[p]),
    );

  const previous = new Map(before.map((row) => [keyOf(row), row]));
  const rows: Row[] = [];
  const removed: Removed[] = [];
  for (const row of now) {
    const key = keyOf(row);
    const old = previous.get(key);
    previous.delete(key);
    if (old && same(old, row)) continue;
    if (matches(row)) rows.push(row);
    else if (old && matches(old)) removed.push({ row: old, reason: "changed" });
  }
  for (const old of previous.values())
    if (matches(old)) removed.push({ row: old, reason: "deleted" });
  return { rows, removed };
}

export { DeltaTokens, deltaChanges };
