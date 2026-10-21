import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { PO_MODEL, start, send } from "./helpers.ts";
import { createApp } from "../lib/app.ts";
import { netChanges, type SetChanges } from "../lib/persistence.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const ORDERS = "PurchaseOrderSet";

function load(modelDir = PO_MODEL) {
  return createApp({ modelDir, v4Path: "/v4", log: () => {} });
}

// Runs fn in a transaction, and returns the net changes its commit hands out
function committed(app: ReturnType<typeof load>, fn: () => void) {
  const { store, model } = app;
  const mark = store.begin();
  fn();
  const changes = netChanges(model, store.commit(mark)!);
  store.settle(true);
  return changes;
}

// A set's changes as [written keys, deleted keys]
const keys = (changes: SetChanges[], set: string) => {
  const of = changes.find((c) => c.set === set);
  return of ? [of.written.map((w) => w.key), of.deleted] : undefined;
};

describe("netChanges", () => {
  it("writes a row changed several times once, as it is at commit", () => {
    const app = load();
    const [first] = app.store.rows(ORDERS);
    const changes = committed(app, () => {
      app.store.update(ORDERS, first, { Status: "One" });
      app.store.update(ORDERS, first, { Status: "Two" });
    });
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0].deleted, []);
    assert.deepEqual(changes[0].written, [
      { key: JSON.stringify([first.PurchaseOrderId]), row: first },
    ]);
  });

  it("hands out copies, which later changes don't reach", () => {
    const app = load();
    const [first] = app.store.rows(ORDERS);
    const [{ written }] = committed(app, () =>
      app.store.update(ORDERS, first, { Status: "Saved" }),
    );
    assert.notEqual(written[0].row, first);
    committed(app, () => app.store.update(ORDERS, first, { Status: "Later" }));
    assert.equal(written[0].row.Status, "Saved");
  });

  it("drops a row inserted and removed again; deletes a removed one", () => {
    const app = load();
    const [first, second] = app.store.rows(ORDERS);
    const temp = { ...first, PurchaseOrderId: "temp" };
    const changes = committed(app, () => {
      app.store.insert(ORDERS, temp);
      app.store.update(ORDERS, temp, { Status: "Brief" });
      app.store.removeRow(ORDERS, temp);
      app.store.removeRow(ORDERS, second);
    });
    assert.deepEqual(keys(changes, ORDERS), [
      [],
      [JSON.stringify([second.PurchaseOrderId])],
    ]);
  });

  it("both deletes and writes a key deleted and created again", () => {
    const app = load();
    const [first] = app.store.rows(ORDERS);
    const key = JSON.stringify([first.PurchaseOrderId]);
    const changes = committed(app, () => {
      app.store.removeRow(ORDERS, first);
      app.store.insert(ORDERS, { ...first, Status: "Recreated" });
    });
    assert.deepEqual(keys(changes, ORDERS), [[key], [key]]);
  });

  it("lists the sets in the order they were first changed", () => {
    const app = load();
    const [item] = app.store.rows("PurchaseOrderItemSet");
    const [order] = app.store.rows(ORDERS);
    const changes = committed(app, () => {
      app.store.update("PurchaseOrderItemSet", item, { Description: "x" });
      app.store.update(ORDERS, order, { Status: "x" });
      app.store.update("PurchaseOrderItemSet", item, { Description: "y" });
    });
    assert.deepEqual(
      changes.map((c) => c.set),
      ["PurchaseOrderItemSet", ORDERS],
    );
  });

  it("refuses a change to a column that identifies the row", () => {
    const app = load();
    const [first] = app.store.rows(ORDERS);
    const mark = app.store.begin();
    app.store.update(ORDERS, first, { PurchaseOrderId: "other" });
    const changes = app.store.commit(mark)!;
    assert.throws(
      () => netChanges(app.model, changes),
      /PurchaseOrderId changed, which identifies the row/,
    );
    app.store.settle(false);
    assert.notEqual(first.PurchaseOrderId, "other");
  });

  it("identifies a contained entity by its parent's keys too", () => {
    const app = load(path.join(FIXTURES, "Containment"));
    const [trip] = app.store.rows("People-Trips");
    const changes = committed(app, () =>
      app.store.update("People-Trips", trip, { Name: "Changed" }),
    );
    assert.deepEqual(keys(changes, "People-Trips"), [
      [JSON.stringify([trip.TripId, trip.Person_UserName])],
      [],
    ]);
  });

  it("identifies a link by all its columns", () => {
    const app = load(path.join(FIXTURES, "ManyToMany"));
    const [link] = app.store.rows("Courses-Students");
    const changes = committed(app, () =>
      app.store.removeRow("Courses-Students", link),
    );
    assert.deepEqual(keys(changes, "Courses-Students"), [
      [],
      [JSON.stringify([link.CourseId, link.Students_StudentId])],
    ]);
  });

  it("refuses a set it can't identify rows of", () => {
    const app = load();
    app.store.addSet("Unknown");
    const mark = app.store.begin();
    app.store.insert("Unknown", { a: 1 });
    const changes = app.store.commit(mark)!;
    assert.throws(() => netChanges(app.model, changes), /no identity/);
    app.store.settle(false);
  });
});

// The net changes of each commit a draft's edit and activation make over HTTP
describe("netChanges of a draft", () => {
  it("edit writes the draft tree and its admin record; activation deletes them", async () => {
    const s = await start(path.join(FIXTURES, "DraftSrv"));
    try {
      const commits: SetChanges[][] = [];
      const commit = s.store.commit.bind(s.store);
      s.store.commit = (mark) => {
        const changes = commit(mark);
        if (changes) commits.push(netChanges(s.model, changes));
        return changes;
      };
      const ID = "b0000000-0000-4000-8000-000000000001";
      const book = (active: boolean) =>
        `${s.v4}/Books(ID=${ID},IsActiveEntity=${active})`;

      const edit = await send(
        "POST",
        `${book(true)}/CatalogService.draftEdit`,
        {},
      );
      assert.equal(edit.status, 200);
      const [edited] = commits.splice(0);
      const active = JSON.stringify([ID, true]);
      const draft = JSON.stringify([ID, false]);
      assert.deepEqual(keys(edited, "Books"), [[active, draft], []]);
      const admin = edited.find((c) => c.set === "$DraftAdministrativeData")!;
      assert.equal(admin.written.length, 1);
      const uuid = admin.written[0].row.DraftUUID;
      assert.equal(admin.written[0].key, JSON.stringify([uuid]));
      const written = (set: string, key: string) =>
        edited.find((c) => c.set === set)!.written.find((w) => w.key === key)!
          .row;
      assert.equal(written("Books", active).HasDraftEntity, true);

      const activated = await send(
        "POST",
        `${book(false)}/CatalogService.draftActivate`,
        {},
      );
      assert.equal(activated.status, 200);
      const [done] = commits.splice(0);
      assert.deepEqual(keys(done, "Books"), [[active], [draft]]);
      assert.deepEqual(keys(done, "$DraftAdministrativeData"), [
        [],
        [JSON.stringify([uuid])],
      ]);
    } finally {
      await s.close();
    }
  });
});
