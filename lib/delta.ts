// Delta links: a client that reads an entity set with Prefer: odata.track-changes gets a
// delta link with its last page, and reading that link later answers what has changed since:
// the entities added or changed, and the ones deleted. V4 writes it as @odata.deltaLink, with
// $deletedEntity entries; V2 as SAP Gateway does, d.__delta with !deltatoken='...', for an
// entity set with sap:change-tracking="true" too, with the deleted ones in d.__deleted.
//
// A delta token stands for a copy of the entity set's rows when it was handed out, and the
// changes are what differs from it now. A copy rather than a log of the writes: rows change in
// place in many places (writes, drafts, operation rules, a $batch changeset rolled back), and
// comparing catches them all. Only the latest tokens are kept, and none across a restart: an
// older one is a 410 Gone, and the client reads the entity set again.

import { applyQuery, type QueryHost } from "./apply-query.ts";
import { HttpError } from "./query.ts";
import type { ODataService } from "./service.ts";
import type {
  EntityType,
  ODataResponse,
  QueryNode,
  ResponseOptions,
  Row,
} from "./model.ts";

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
  issue(setName: string, rows: readonly Row[]): string {
    const token = `${this.epoch}-${this.next++}`;
    this.copies.set(token, { setName, rows: structuredClone([...rows]) });
    if (this.copies.size > KEPT)
      this.copies.delete(this.copies.keys().next().value!);
    return token;
  }

  // The rows a token stands for, or undefined for one that's unknown or no longer kept
  rows(token: string, setName: string): Row[] | undefined {
    const copy = this.copies.get(token);
    return copy?.setName === setName ? copy.rows : undefined;
  }

  // Drops the entity set's tokens: its rows were replaced, not changed (see live-rules.ts), so
  // reading one of its delta links is a 410 Gone, as after a restart
  forget(setName: string): void {
    for (const [token, copy] of this.copies)
      if (copy.setName === setName) this.copies.delete(token);
  }
}

// What differs between the rows a token stands for and the current ones, for the client's
// $filter and $search: the entities that match now and are new or changed, and the ones that
// matched before and are now deleted or no longer match.
function deltaChanges(
  svc: QueryHost,
  type: EntityType,
  before: readonly Row[],
  now: readonly Row[],
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

// Whether a GET of an entity set gets a delta link: a client asks for one with Prefer:
// odata.track-changes, or, in V2, the set is delta-enabled (sap:change-tracking="true", as
// SAP Gateway marks it), and the query is one a delta can answer, without $apply, $compute,
// $skip or $top. Otherwise the preference isn't applied, as the spec allows.
function tracksChanges(
  svc: ODataService,
  setName: string,
  prefer: string,
  q: QueryNode,
): boolean {
  const enabled =
    svc.protocol.version === "2.0" &&
    svc.model.entitySets[setName]?.sap?.["change-tracking"] === "true";
  return (
    !!svc.protocol.delta &&
    (enabled || /odata\.track-changes/i.test(prefer)) &&
    !q.apply &&
    !q.compute &&
    q.skip === undefined &&
    q.top === undefined
  );
}

// What changed in the entity set since the delta token (see delta.ts), with a new delta
// link. A token that's unknown, no longer kept or from before a restart is a 410 Gone. Only
// V4 parses a $deltatoken, and has delta().
function deltaResponse(
  svc: ODataService,
  setName: string,
  type: EntityType,
  q: QueryNode,
  opts: ResponseOptions,
  link: (token: string) => string,
): ODataResponse {
  const before = svc.deltaTokens.rows(q.deltatoken!, setName);
  if (!before)
    throw new HttpError(
      410,
      "The delta link has expired: read the entity set again for a new one",
      "DeltaLinkExpired",
    );
  const now = svc.store.rows(setName);
  const changes = deltaChanges(svc, type, before, now, q);
  const deltaLink = link(svc.deltaTokens.issue(setName, now));
  return svc.protocol.delta!(
    svc,
    { ...changes, deltaLink },
    setName,
    type,
    q,
    opts,
  );
}

export { DeltaTokens, deltaChanges, tracksChanges, deltaResponse };
