// The rows of a link set (see linkSet in navigations.ts): pairs of keys that join two entity
// sets' rows for a navigation no key can join, a many-to-many one. The store keeps them under
// the link set's name, as it keeps an entity set's rows, so a $batch changeset rolls them
// back too.

import type { LinkEnd, Model, Navigation, Row } from "./model.ts";
import type { Store } from "./store.ts";

// The navigation's source end and target end
function endsOf(model: Model, nav: Navigation): [LinkEnd, LinkEnd] {
  const { ends } = model.linkSets[nav.links!.set];
  return nav.links!.from === 0 ? [ends[0], ends[1]] : [ends[1], ends[0]];
}

const holds = (link: Row, end: LinkEnd, row: Row) =>
  end.columns.every((c, i) => String(link[c]) === String(row[end.keys[i]]));

// The target rows linked to row
function linkedRows(
  model: Model,
  store: Store,
  nav: Navigation,
  row: Row,
): Row[] {
  const [from, to] = endsOf(model, nav);
  const links = store.rows(nav.links!.set).filter((l) => holds(l, from, row));
  return store
    .rows(to.set)
    .filter((target) => links.some((l) => holds(l, to, target)));
}

// Links row to target, unless they are already
function addLink(
  model: Model,
  store: Store,
  nav: Navigation,
  row: Row,
  target: Row,
): void {
  const [from, to] = endsOf(model, nav);
  const links = store.rows(nav.links!.set);
  if (links.some((l) => holds(l, from, row) && holds(l, to, target))) return;
  const link: Row = {};
  from.columns.forEach((c, i) => (link[c] = row[from.keys[i]]));
  to.columns.forEach((c, i) => (link[c] = target[to.keys[i]]));
  store.insert(nav.links!.set, link);
}

// Unlinks row from target
function removeLink(
  model: Model,
  store: Store,
  nav: Navigation,
  row: Row,
  target: Row,
): void {
  const [from, to] = endsOf(model, nav);
  const set = nav.links!.set;
  for (const l of store
    .rows(set)
    .filter((l) => holds(l, from, row) && holds(l, to, target)))
    store.removeRow(set, l);
}

// Removes the links of a row of the entity set that is being deleted
function unlink(model: Model, store: Store, setName: string, row: Row): void {
  for (const set of Object.values(model.linkSets))
    for (const end of set.ends)
      if (end.set === setName)
        for (const l of store.rows(set.name).filter((l) => holds(l, end, row)))
          store.removeRow(set.name, l);
}

export { linkedRows, addLink, removeLink, unlink };
