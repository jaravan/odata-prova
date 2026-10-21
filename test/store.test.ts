import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PO_MODEL } from "./helpers.ts";
import { createApp } from "../lib/app.ts";
import type { Row } from "../lib/model.ts";

const SET = "PurchaseOrderSet";

// A store on PO_MODEL's seed data, as the app builds it
function load() {
  const { store, model } = createApp({
    modelDir: PO_MODEL,
    v4Path: "/v4",
    log: () => {},
  });
  const type = model.entityTypes[model.entitySets[SET].entityType];
  const key = (row: Row) => ({
    PurchaseOrderId: row.PurchaseOrderId,
  });
  return { store, type, key };
}

describe("Store transactions", () => {
  it("rollback undoes inserts, updates and removes, on the same row objects", () => {
    const { store, type, key } = load();
    const rows = [...store.rows(SET)];
    const before = structuredClone(rows);
    const [first, second] = rows;

    const mark = store.begin();
    store.insert(SET, { ...first, PurchaseOrderId: "new" });
    store.update(SET, first, { Status: "Changed", Extra: "added" });
    store.remove(SET, type, key(second));
    store.rollback(mark);

    assert.deepEqual(store.rows(SET), before);
    store.rows(SET).forEach((row, i) => assert.equal(row, rows[i]));
    assert.ok(!("Extra" in first));
  });

  it("commit keeps the changes, and the outermost returns them", () => {
    const { store, type, key } = load();
    const [first, second] = store.rows(SET);

    const mark = store.begin();
    store.update(SET, first, { Status: "Changed" });
    store.remove(SET, type, key(second));
    const changes = store.commit(mark)!;
    store.settle(true);

    assert.equal(first.Status, "Changed");
    assert.ok(!store.rows(SET).includes(second));
    assert.deepEqual(
      changes.map((c) => [c.op, c.row]),
      [
        ["update", first],
        ["remove", second],
      ],
    );
  });

  it("logs no change made outside a transaction", () => {
    const { store } = load();
    const [first] = store.rows(SET);
    store.update(SET, first, { Status: "Before" });

    const mark = store.begin();
    store.update(SET, first, { Status: "Inside" });
    assert.equal(store.commit(mark)!.length, 1);
  });

  it("an inner rollback undoes only its own changes", () => {
    const { store } = load();
    const [first, second] = store.rows(SET);

    const outer = store.begin();
    store.update(SET, first, { Status: "Outer" });
    const inner = store.begin();
    store.update(SET, second, { Status: "Inner" });
    store.rollback(inner);
    const changes = store.commit(outer)!;
    store.settle(true);

    assert.equal(first.Status, "Outer");
    assert.notEqual(second.Status, "Inner");
    assert.equal(changes.length, 1);
  });

  it("an outer rollback undoes an inner transaction that committed", () => {
    const { store } = load();
    const [first] = store.rows(SET);
    const status = first.Status;

    const outer = store.begin();
    const inner = store.begin();
    store.update(SET, first, { Status: "Inner" });
    assert.equal(store.commit(inner), undefined);
    store.rollback(outer);

    assert.equal(first.Status, status);
  });

  it("refuses to end a transaction other than the innermost", () => {
    const { store } = load();
    const outer = store.begin();
    store.begin();
    assert.throws(() => store.commit(outer), /innermost/);
  });
});

describe("Store audit", () => {
  it("passes changes made through the store", () => {
    const { store, type, key } = load();
    store.audit = true;
    const [first, second] = store.rows(SET);

    let mark = store.begin();
    store.update(SET, first, { Status: "Changed" });
    store.remove(SET, type, key(second));
    store.insert(SET, { ...second, PurchaseOrderId: "new" });
    store.commit(mark);
    store.settle(true);

    mark = store.begin();
    store.update(SET, first, { Status: "Again" });
    store.rollback(mark);
  });

  it("fails a saved commit when a row changed without going through the store", () => {
    const { store } = load();
    store.audit = true;
    const [first] = store.rows(SET);

    const mark = store.begin();
    first.Status = "Behind the store's back";
    store.commit(mark);
    assert.throws(() => store.settle(true), /store audit/);
  });

  it("fails a rollback that leaves a change behind", () => {
    const { store } = load();
    store.audit = true;
    const [first] = store.rows(SET);

    const mark = store.begin();
    store.update(SET, first, { Status: "Logged" });
    first.Supplier = "Not logged";
    assert.throws(() => store.rollback(mark), /store audit/);
  });
});

describe("Store lookup", () => {
  const ITEMS = "PurchaseOrderItemSet";
  const byOrder = (store: ReturnType<typeof load>["store"], id: unknown) =>
    store.lookup(ITEMS, ["PurchaseOrderId"], [id as string]);
  const scan = (store: ReturnType<typeof load>["store"], id: unknown) =>
    store.rows(ITEMS).filter((r) => String(r.PurchaseOrderId) === String(id));

  it("finds what a scan finds, in the set's order, comparing as strings", () => {
    const { store } = load();
    const [first] = store.rows(ITEMS);
    const id = first.PurchaseOrderId;
    assert.ok(byOrder(store, id).length > 1);
    assert.deepEqual(byOrder(store, id), scan(store, id));
    assert.deepEqual(byOrder(store, Number(id)), scan(store, id));
    assert.deepEqual(byOrder(store, "none"), []);
  });

  it("follows inserts, updates of the indexed columns, removes and rollbacks", () => {
    const { store } = load();
    const [first, second] = store.rows(ITEMS);
    const id = String(first.PurchaseOrderId);
    byOrder(store, id); // built

    const mark = store.begin();
    store.insert(ITEMS, { ...first, ItemPosition: "9999" });
    assert.deepEqual(byOrder(store, id), scan(store, id));
    store.update(ITEMS, second, { PurchaseOrderId: "moved" });
    assert.deepEqual(byOrder(store, "moved"), [second]);
    assert.deepEqual(byOrder(store, id), scan(store, id));
    store.removeRow(ITEMS, first);
    assert.ok(!byOrder(store, id).includes(first));
    store.rollback(mark);

    assert.deepEqual(byOrder(store, "moved"), []);
    assert.deepEqual(byOrder(store, id), scan(store, id));
    assert.ok(byOrder(store, id).includes(first));
  });

  it("keeps serving rows whose other columns changed", () => {
    const { store } = load();
    const [first] = store.rows(ITEMS);
    const id = first.PurchaseOrderId;
    byOrder(store, id);
    store.update(ITEMS, first, { Description: "Changed" });
    assert.equal(byOrder(store, id)[0].Description, "Changed");
  });
});

describe("Store sets", () => {
  it("adds a set outside a transaction only", () => {
    const { store } = load();
    store.addSet("Extra");
    assert.deepEqual(store.rows("Extra"), []);
    const mark = store.begin();
    assert.throws(() => store.addSet("Late"), /inside a transaction/);
    store.rollback(mark);
  });
});

describe("Store commits held until settled", () => {
  it("settle(true) keeps the changes, settle(false) undoes them", () => {
    const { store, type, key } = load();
    store.audit = true;
    const rows = [...store.rows(SET)];
    const before = structuredClone(rows);
    const [first, second] = rows;

    let mark = store.begin();
    store.update(SET, first, { Status: "Saved" });
    store.commit(mark);
    store.settle(true);
    assert.equal(first.Status, "Saved");

    mark = store.begin();
    store.update(SET, first, { Status: "Not saved" });
    store.remove(SET, type, key(second));
    store.insert(SET, { ...second, PurchaseOrderId: "new" });
    store.commit(mark);
    store.settle(false);
    assert.deepEqual(store.rows(SET), [
      { ...before[0], Status: "Saved" },
      ...before.slice(1),
    ]);
    store.rows(SET).forEach((row, i) => assert.equal(row, rows[i]));
  });

  it("settle(false) drops the indexes the undone changes made wrong", () => {
    const { store } = load();
    const ITEMS = "PurchaseOrderItemSet";
    const [item] = store.rows(ITEMS);
    const id = item.PurchaseOrderId as string;
    store.lookup(ITEMS, ["PurchaseOrderId"], [id]);

    const mark = store.begin();
    store.update(ITEMS, item, { PurchaseOrderId: "moved" });
    store.commit(mark);
    store.settle(false);
    assert.ok(store.lookup(ITEMS, ["PurchaseOrderId"], [id]).includes(item));
    assert.deepEqual(store.lookup(ITEMS, ["PurchaseOrderId"], ["moved"]), []);
  });

  it("nothing changes the store, nor begins, while a commit is held", () => {
    const { store } = load();
    const [first] = store.rows(SET);
    const mark = store.begin();
    store.update(SET, first, { Status: "Held" });
    store.commit(mark);

    assert.throws(() => store.begin(), /while a commit is being saved/);
    assert.throws(
      () => store.update(SET, first, { Status: "Sneaked in" }),
      /while a commit is being saved/,
    );
    store.settle(true);
    assert.equal(first.Status, "Held");
    store.commit(store.begin());
    store.settle(true);
  });

  it("settle() needs a held commit", () => {
    const { store } = load();
    assert.throws(() => store.settle(true), /without a commit/);
    const outer = store.begin();
    store.begin();
    store.commit(1);
    assert.throws(() => store.settle(true), /without a commit/);
    store.rollback(outer);
  });

  it("transactionsOnly refuses a change outside a transaction", () => {
    const { store } = load();
    const [first] = store.rows(SET);
    store.transactionsOnly = true;
    assert.throws(
      () => store.update(SET, first, { Status: "Outside" }),
      /outside a transaction/,
    );
    assert.notEqual(first.Status, "Outside");
    const mark = store.begin();
    store.update(SET, first, { Status: "Inside" });
    store.commit(mark);
    store.settle(true);
    assert.equal(first.Status, "Inside");
  });
});

describe("Store load", () => {
  it("replaces the rows of the sets it's given, outside a transaction only", () => {
    const { store } = load();
    const [first] = store.rows(SET);
    const items = store.rows("PurchaseOrderItemSet");
    store.load({ [SET]: [{ ...first, Status: "Loaded" }], Unknown: [] });
    assert.deepEqual(
      store.rows(SET).map((r) => r.Status),
      ["Loaded"],
    );
    assert.equal(store.rows("PurchaseOrderItemSet"), items);
    assert.equal(store.sets().Unknown, undefined);

    const mark = store.begin();
    assert.throws(() => store.load({ [SET]: [] }), /inside a transaction/);
    store.rollback(mark);
  });
});
