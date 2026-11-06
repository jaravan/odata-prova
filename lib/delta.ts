// Delta links: a client that reads an entity set with Prefer: odata.track-changes gets a
// delta link with its last page, and reading that link later answers what has changed since:
// the entities added or changed, and the ones deleted. V4 writes it as @odata.deltaLink, with
// $deletedEntity entries; V2 as SAP Gateway does, d.__delta with !deltatoken='...', for an
// entity set with sap:change-tracking="true" too, with the deleted ones in d.__deleted.
//
// A delta token stands for a copy of the entity set's rows when it was handed out, with which
// of them its $filter and $search matched, and the changes are what differs from it now. A
// copy rather than a log of the writes: rows change in place in many places (writes, drafts,
// operation rules, a $batch changeset rolled back), and comparing catches them all. Which ones
// matched is kept because a $filter can reach other sets: an entity can stop matching with no
// change of its own, and what its old copy matches now says nothing of what it matched then.
// Only the latest tokens are kept, and none across a restart: an older one is a 410 Gone, and
// the client reads the entity set again.

import { applyQuery, type QueryHost } from "./apply-query.ts";
import { HttpError } from "./query.ts";
import { spend } from "./work.ts";
import { floatJson } from "./types.ts";
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
// Copying a row, in steps of an expression (see work.ts)
const COPY_WORK = 10;

// An entity that left the client's set since its token: deleted, or changed so that it no
// longer matches the $filter or $search
export interface Removed {
  row: Row;
  reason: "deleted" | "changed";
}

// An entity set as a client read it
interface Snapshot {
  setName: string;
  filter?: string;
  search?: string;
  rows: Row[];
  // The keys of the rows that $filter and $search matched
  matched: Set<string>;
}

class DeltaTokens {
  // Tokens from before a restart don't match, even though the counter starts over
  private epoch = Date.now().toString(36);
  private next = 1;
  private copies = new Map<string, Snapshot>();

  // A token for the entity set's rows as they are now
  issue(snapshot: Snapshot): string {
    const token = `${this.epoch}-${this.next++}`;
    this.copies.set(token, snapshot);
    if (this.copies.size > KEPT)
      this.copies.delete(this.copies.keys().next().value!);
    return token;
  }

  // What a token stands for, or undefined for one that's unknown, no longer kept or for
  // another read
  read(token: string, setName: string, q: QueryNode): Snapshot | undefined {
    const copy = this.copies.get(token);
    return copy?.setName === setName &&
      copy.filter === q.filter &&
      copy.search === q.search
      ? copy
      : undefined;
  }

  // Drops the entity set's tokens: its rows were replaced, not changed (see live-rules.ts), so
  // reading one of its delta links is a 410 Gone, as after a restart
  forget(setName: string): void {
    for (const [token, copy] of this.copies)
      if (copy.setName === setName) this.copies.delete(token);
  }
}

const keyOf = (type: EntityType, row: Row) =>
  JSON.stringify(type.keys.map((k) => String(row[k])));

// The keys of the rows the query's $filter and $search match, as the rows are now
function matchedKeys(
  svc: QueryHost,
  type: EntityType,
  rows: readonly Row[],
  q: QueryNode,
): Set<string> {
  const { results } = applyQuery(svc, [...rows], type, {
    expand: {},
    filter: q.filter,
    search: q.search,
  });
  return new Set(results.map((row) => keyOf(type, row)));
}

// What the token for a read of the entity set stands for: its rows and what matched, now
function snapshot(
  svc: QueryHost,
  setName: string,
  type: EntityType,
  rows: readonly Row[],
  q: QueryNode,
): Snapshot {
  spend(rows.length * COPY_WORK);
  return {
    setName,
    filter: q.filter,
    search: q.search,
    rows: structuredClone([...rows]),
    matched: matchedKeys(svc, type, rows, q),
  };
}

// What differs between what a token stands for and the current rows: the entities that match
// now and are new, changed or didn't match before, and the ones that matched before and are
// now deleted or no longer match. One that matches throughout, unchanged itself, isn't one.
function deltaChanges(
  type: EntityType,
  before: Snapshot,
  now: readonly Row[],
  matched: Set<string>,
): { rows: Row[]; removed: Removed[] } {
  const same = (a: Row, b: Row) =>
    Object.keys(type.properties).every(
      (p) => floatJson(a[p]) === floatJson(b[p]),
    );

  const previous = new Map(before.rows.map((row) => [keyOf(type, row), row]));
  const rows: Row[] = [];
  const removed: Removed[] = [];
  for (const row of now) {
    const key = keyOf(type, row);
    const old = previous.get(key);
    previous.delete(key);
    const matchedThen = before.matched.has(key);
    if (matched.has(key)) {
      if (!matchedThen || !old || !same(old, row)) rows.push(row);
    } else if (old && matchedThen)
      removed.push({ row: old, reason: "changed" });
  }
  for (const [key, old] of previous)
    if (before.matched.has(key)) removed.push({ row: old, reason: "deleted" });
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
  const before = svc.deltaTokens.read(q.deltatoken!, setName, q);
  if (!before)
    throw new HttpError(
      410,
      "The delta link has expired: read the entity set again for a new one",
      "DeltaLinkExpired",
    );
  const now = svc.store.rows(setName);
  const changes = deltaChanges(
    type,
    before,
    now,
    matchedKeys(svc, type, now, q),
  );
  const deltaLink = link(
    svc.deltaTokens.issue(snapshot(svc, setName, type, now, q)),
  );
  return svc.protocol.delta!(
    svc,
    { ...changes, deltaLink },
    setName,
    type,
    q,
    opts,
  );
}

export { DeltaTokens, snapshot, tracksChanges, deltaResponse };
