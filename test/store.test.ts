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
    const changes = store.commit(mark);

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
    assert.equal(store.commit(mark).length, 1);
  });

  it("an inner rollback undoes only its own changes", () => {
    const { store } = load();
    const [first, second] = store.rows(SET);

    const outer = store.begin();
    store.update(SET, first, { Status: "Outer" });
    const inner = store.begin();
    store.update(SET, second, { Status: "Inner" });
    store.rollback(inner);
    const changes = store.commit(outer);

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
    assert.deepEqual(store.commit(inner), []);
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

    mark = store.begin();
    store.update(SET, first, { Status: "Again" });
    store.rollback(mark);
  });

  it("fails a commit when a row changed without going through the store", () => {
    const { store } = load();
    store.audit = true;
    const [first] = store.rows(SET);

    const mark = store.begin();
    first.Status = "Behind the store's back";
    assert.throws(() => store.commit(mark), /store audit/);
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
