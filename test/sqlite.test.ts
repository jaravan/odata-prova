import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { start, send, ORDER, PO_MODEL } from "./helpers.ts";
import { createApp } from "../lib/app.ts";
import { SqlitePersistence } from "../lib/sqlite.ts";

// What only the SQLite file has to get right; every kind of write, against it too, is in
// persistence-flows.test.ts

const FIXTURES = path.join(import.meta.dirname, "fixtures");

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-"));
  file = path.join(dir, "state.db");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// An app on modelDir and the file, started; closed, so the file can be opened again
async function startClose(modelDir = PO_MODEL) {
  const app = createApp({
    modelDir,
    v4Path: "/v4",
    log: () => {},
    persistence: new SqlitePersistence(file),
  });
  await app.ready;
  await app.close();
  return app;
}

describe("SqlitePersistence", () => {
  it("an empty file is no state yet; the first commit makes one", async () => {
    const db = new SqlitePersistence(file);
    assert.equal(await db.load(), undefined);
    await db.commit([
      { set: "A", written: [{ key: "[1]", row: { id: 1 } }], deleted: [] },
    ]);
    await db.close();
    const again = new SqlitePersistence(file);
    assert.deepEqual(await again.load(), { A: [{ id: 1 }] });
    await again.close();
  });

  it("keeps the rows' order across a restart: in place when changed, last when new", async () => {
    const s = await start(PO_MODEL, {
      persistence: new SqlitePersistence(file),
    });
    try {
      await s.ready;
      const orders = `${s.v4}/PurchaseOrderSet`;
      await send("POST", orders, { ...ORDER, PurchaseOrderId: "N1" });
      await send("PATCH", `${orders}('4500000001')`, { Status: "Changed" });
      const [, second] = s.store.rows("PurchaseOrderSet");
      await send("DELETE", `${orders}('${String(second.PurchaseOrderId)}')`);
      await send("POST", orders, { ...ORDER, PurchaseOrderId: "N2" });
    } finally {
      await s.close();
    }
    const ids = (rows: readonly { PurchaseOrderId?: unknown }[]) =>
      rows.map((r) => r.PurchaseOrderId);
    const again = await startClose();
    assert.deepEqual(
      ids(again.store.rows("PurchaseOrderSet")),
      ids(s.store.rows("PurchaseOrderSet")),
    );
    assert.deepEqual(ids(again.store.rows("PurchaseOrderSet")).slice(-2), [
      "N1",
      "N2",
    ]);
  });

  it("a set whose rows were all deleted stays empty after a restart", async () => {
    const s = await start(PO_MODEL, {
      persistence: new SqlitePersistence(file),
    });
    try {
      await s.ready;
      for (const item of [...s.store.rows("PurchaseOrderItemSet")])
        await send(
          "DELETE",
          `${s.v4}/PurchaseOrderItemSet(PurchaseOrderId='${String(item.PurchaseOrderId)}',ItemPosition='${String(item.ItemPosition)}')`,
        );
      assert.equal(s.store.rows("PurchaseOrderItemSet").length, 0);
    } finally {
      await s.close();
    }
    const again = await startClose();
    assert.deepEqual(again.store.rows("PurchaseOrderItemSet"), []);
  });

  it("INF, -INF and NaN survive; a string that reads INF stays a string", async () => {
    const first = await startClose(path.join(FIXTURES, "SpecialFloats"));
    const values = first.store.rows("Ms").map((r) => r.V);
    assert.deepEqual(values.slice(0, 3), [Infinity, -Infinity, NaN]);
    const again = await startClose(path.join(FIXTURES, "SpecialFloats"));
    assert.deepEqual(
      again.store.rows("Ms").map((r) => r.V),
      values,
    );
    const raw = new DatabaseSync(file);
    const saved = raw
      .prepare("SELECT row FROM rows WHERE set_name = 'Ms' ORDER BY seq")
      .all() as { row: string }[];
    raw.close();
    assert.equal(saved[0].row, '{"ID":1,"V":{"$float":"INF"}}');

    const db = new SqlitePersistence(file);
    await db.load();
    await db.commit([
      { set: "S", written: [{ key: "[1]", row: { s: "INF" } }], deleted: [] },
    ]);
    assert.deepEqual(db.state().S, [{ s: "INF" }]);
    await db.close();
  });

  it("one process per file: a second one is refused while the first has it open", async () => {
    const first = new SqlitePersistence(file);
    await first.load();
    const second = new SqlitePersistence(file);
    await assert.rejects(
      second.load(),
      /is in use by another process: one server per file/,
    );
    await first.close();
    await second.load();
    await second.close();
  });

  it("a failed commit leaves the file as it was: its deletes are rolled back too", async () => {
    const db = new SqlitePersistence(file);
    await db.load();
    await db.commit([
      { set: "A", written: [{ key: "[1]", row: { id: 1 } }], deleted: [] },
    ]);
    await assert.rejects(
      db.commit([
        {
          set: "A",
          deleted: ["[1]"],
          // JSON can't hold a BigInt: the write throws after the delete ran
          written: [{ key: "[2]", row: { id: 2n as unknown as number } }],
        },
      ]),
      /BigInt/,
    );
    assert.deepEqual(db.state(), { A: [{ id: 1 }] });
    await db.close();
  });

  it("a file that isn't a database: the app's every request is a 503", async () => {
    fs.writeFileSync(file, "not a database, just text, ".repeat(10));
    const s = await start(PO_MODEL, {
      persistence: new SqlitePersistence(file),
    });
    try {
      await assert.rejects(
        s.ready,
        /could not be loaded: file is not a database/,
      );
      const r = await send("PATCH", `${s.v4}/PurchaseOrderSet('4500000001')`, {
        Status: "x",
      });
      assert.equal(r.status, 503);
    } finally {
      await s.close();
    }
  });

  it("a file of another format isn't read", async () => {
    await startClose();
    const raw = new DatabaseSync(file);
    raw.exec("UPDATE meta SET value = '9' WHERE name = 'format'");
    raw.close();
    const db = new SqlitePersistence(file);
    await assert.rejects(db.load(), /has format 9, this version reads 1/);
    // and doesn't keep it locked
    const other = new SqlitePersistence(file);
    await assert.rejects(other.load(), /has format 9/);
  });

  it("a commit when not open is refused", async () => {
    await assert.rejects(new SqlitePersistence(file).commit([]), /is not open/);
  });
});
