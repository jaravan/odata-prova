import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { start, get, send, ORDER, PO_MODEL } from "./helpers.ts";
import { createApp } from "../lib/app.ts";
import { PostgresPersistence, isPostgresUrl, redact } from "../lib/postgres.ts";
import { StaleError } from "../lib/persistence.ts";

// What only PostgreSQL has to get right; every kind of write, against it too, is in
// persistence-flows.test.ts. Needs POSTGRES_URL: yarn test:postgres starts one in Docker.

const POSTGRES_URL = process.env.POSTGRES_URL;
const skip = !POSTGRES_URL && "needs POSTGRES_URL (yarn test:postgres)";

const DRAFT_MODEL = path.join(import.meta.dirname, "fixtures", "DraftSrv");

// A service name no other test uses
const fresh = () => `test-${randomUUID()}`;

describe("postgres URLs", () => {
  it("tell a database from a file", () => {
    assert.ok(isPostgresUrl("postgres://u@h/db"));
    assert.ok(isPostgresUrl("postgresql://u@h/db"));
    assert.ok(!isPostgresUrl("./postgres.db"));
    assert.ok(!isPostgresUrl("/state/MySrv.db"));
  });

  it("are logged without their password or parameters", () => {
    assert.equal(
      redact("postgres://me:secret@db:5432/mock?sslpassword=x"),
      "postgres://me@db:5432/mock",
    );
    assert.equal(redact("postgres://u:p@[bad/db"), "the database");
  });
});

describe("PostgresPersistence", { skip }, () => {
  const url = POSTGRES_URL!;

  it("a new service is no state yet; the first commit makes one", async () => {
    const service = fresh();
    const db = new PostgresPersistence(url, service);
    assert.equal(await db.load(), undefined);
    await db.commit([
      { set: "A", written: [{ key: "[1]", row: { id: 1 } }], deleted: [] },
    ]);
    await db.close();
    const again = new PostgresPersistence(url, service);
    assert.deepEqual(await again.load(), {
      state: { A: [{ id: 1 }] },
      shape: undefined,
    });
    await again.close();
  });

  it("servers share a service: a commit that isn't caught up is refused, until it is", async () => {
    const service = fresh();
    const a = new PostgresPersistence(url, service);
    const b = new PostgresPersistence(url, service);
    await a.load();
    await b.load();
    try {
      const write = (id: number) => [
        { set: "S", written: [{ key: `[${id}]`, row: { id } }], deleted: [] },
      ];
      await a.commit(write(1));
      await assert.rejects(b.commit(write(2)), StaleError);
      assert.deepEqual(await b.since(), { changes: [write(1)] });
      await b.commit(write(2));
      assert.deepEqual(await a.since(), { changes: [write(2)] });
      assert.deepEqual(await a.state(), { S: [{ id: 1 }, { id: 2 }] });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a turn's lock holds the other servers' commits off until it ends", async () => {
    const service = fresh();
    const a = new PostgresPersistence(url, service);
    const b = new PostgresPersistence(url, service);
    await a.load();
    await b.load();
    try {
      await a.lock();
      let saved = false;
      const commit = b
        .commit([{ set: "S", written: [], deleted: [] }])
        .then(() => (saved = true));
      await sleep(200);
      assert.equal(saved, false);
      await a.unlock();
      await commit;
      assert.equal(saved, true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a server further behind than the log goes back loads the whole state", async () => {
    const service = fresh();
    const a = new PostgresPersistence(url, service, { keep: 2 });
    const b = new PostgresPersistence(url, service, { keep: 2 });
    await a.load();
    await b.load();
    try {
      for (const id of [1, 2, 3, 4])
        await a.commit([
          { set: "S", written: [{ key: `[${id}]`, row: { id } }], deleted: [] },
        ]);
      const news = await b.since();
      assert.ok("state" in news);
      assert.deepEqual(news.state.state.S, [
        { id: 1 },
        { id: 2 },
        { id: 3 },
        { id: 4 },
      ]);
      // Caught up: nothing new after
      assert.deepEqual(await b.since(), { changes: [] });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a connection that's lost is opened again", async () => {
    const name = `odata-prova-${randomUUID().slice(0, 8)}`;
    const named = `${url}${url.includes("?") ? "&" : "?"}application_name=${name}`;
    const db = new PostgresPersistence(named, fresh());
    await db.load();
    try {
      const { default: pg } = await import("pg");
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      const killed = await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1",
        [name],
      );
      await admin.end();
      assert.ok(killed.rowCount! > 0);
      await sleep(200);
      await db.commit([
        { set: "S", written: [{ key: "[1]", row: { id: 1 } }], deleted: [] },
      ]);
      assert.deepEqual(await db.state(), { S: [{ id: 1 }] });
    } finally {
      await db.close();
    }
  });

  it("replicas: writes on both, at once, end up on both, as saved", async () => {
    const serviceName = fresh();
    const a = await start(PO_MODEL, { persist: url, serviceName });
    const b = await start(PO_MODEL, { persist: url, serviceName });
    try {
      await Promise.all([a.ready, b.ready]);
      const writes = [];
      for (let i = 0; i < 10; i++) {
        const s = i % 2 ? b : a;
        writes.push(
          send("POST", `${s.v4}/PurchaseOrderSet`, {
            ...ORDER,
            PurchaseOrderId: `R${i}`,
          }),
          send("PATCH", `${s.v4}/PurchaseOrderSet('4500000001')`, {
            Supplier: `S${i}`,
          }),
        );
      }
      for (const w of writes) assert.ok((await w).status < 300);
      // A read on each catches it up
      const ids = async (s: typeof a) =>
        (
          await get(`${s.v4}/PurchaseOrderSet?$select=PurchaseOrderId`)
        ).body.value.map((o: { PurchaseOrderId: string }) => o.PurchaseOrderId);
      assert.deepEqual(await ids(a), await ids(b));
      assert.equal(
        (await ids(a)).filter((id: string) => /^R/.test(id)).length,
        10,
      );
      assert.deepEqual(
        a.store.rows("PurchaseOrderSet"),
        b.store.rows("PurchaseOrderSet"),
      );
      // And what's saved is what they hold
      const db = new PostgresPersistence(url, serviceName);
      const saved = await db.load();
      await db.close();
      assert.deepEqual(
        saved?.state.PurchaseOrderSet,
        a.store.rows("PurchaseOrderSet"),
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("replicas: a draft edited on one is saved on the other", async () => {
    const serviceName = fresh();
    const a = await start(DRAFT_MODEL, { persist: url, serviceName });
    const b = await start(DRAFT_MODEL, { persist: url, serviceName });
    const book = (active: boolean) =>
      `Books(ID=b0000000-0000-4000-8000-000000000001,IsActiveEntity=${active})`;
    try {
      await Promise.all([a.ready, b.ready]);
      assert.equal(
        (
          await send("POST", `${a.v4}/${book(true)}/CatalogService.draftEdit`, {
            PreserveChanges: true,
          })
        ).status,
        200,
      );
      assert.equal(
        (await send("PATCH", `${b.v4}/${book(false)}`, { title: "Replicated" }))
          .status,
        204,
      );
      assert.equal(
        (
          await send(
            "POST",
            `${a.v4}/${book(false)}/CatalogService.draftActivate`,
            {},
          )
        ).status,
        200,
      );
      assert.equal(
        (await get(`${b.v4}/${book(true)}`)).body.title,
        "Replicated",
      );
      assert.equal((await get(`${b.v4}/${book(false)}`)).status, 404);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("replicas starting at once on nothing saved: one seeds it, for all", async () => {
    const serviceName = fresh();
    const [a, b] = await Promise.all([
      start(PO_MODEL, { persist: url, serviceName }),
      start(PO_MODEL, { persist: url, serviceName }),
    ]);
    try {
      await Promise.all([a.ready, b.ready]);
      assert.deepEqual(
        a.store.rows("PurchaseOrderSet"),
        b.store.rows("PurchaseOrderSet"),
      );
      await send("POST", `${a.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: "X1",
      });
      assert.equal((await get(`${b.v4}/PurchaseOrderSet('X1')`)).status, 200);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("services in one database keep their rows apart", async () => {
    const a = new PostgresPersistence(url, fresh());
    const b = new PostgresPersistence(url, fresh());
    await a.load();
    await b.load();
    try {
      const row = (id: number) => ({ key: `[${id}]`, row: { id } });
      await a.commit([{ set: "S", written: [row(1)], deleted: [] }]);
      await b.commit([{ set: "S", written: [row(2)], deleted: [] }]);
      await b.replace([{ set: "T", written: [row(3)], deleted: [] }], {
        sets: {},
      });
      assert.deepEqual(await a.state(), { S: [{ id: 1 }] });
      assert.deepEqual(await b.state(), { T: [{ id: 3 }] });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("keeps INF, -INF and NaN, which JSON can't hold", async () => {
    const db = new PostgresPersistence(url, fresh());
    await db.load();
    try {
      await db.commit([
        {
          set: "S",
          written: [
            { key: "[1]", row: { id: 1, d: Infinity } },
            { key: "[2]", row: { id: 2, d: -Infinity } },
            { key: "[3]", row: { id: 3, d: NaN } },
          ],
          deleted: [],
        },
      ]);
      assert.deepEqual(await db.state(), {
        S: [
          { id: 1, d: Infinity },
          { id: 2, d: -Infinity },
          { id: 3, d: NaN },
        ],
      });
    } finally {
      await db.close();
    }
  });

  it("keeps the rows' order across a restart: in place when changed, last when new", async () => {
    const service = fresh();
    const s = await start(PO_MODEL, {
      persistence: new PostgresPersistence(url, service),
    });
    let order: unknown[];
    try {
      await s.ready;
      const orders = `${s.v4}/PurchaseOrderSet`;
      await send("POST", orders, { ...ORDER, PurchaseOrderId: "N1" });
      await send("PATCH", `${orders}('4500000001')`, { Status: "Changed" });
      order = s.store.rows("PurchaseOrderSet").map((r) => r.PurchaseOrderId);
      assert.equal(order.at(-1), "N1");
    } finally {
      await s.close();
    }
    const again = createApp({
      modelDir: PO_MODEL,
      v4Path: "/v4",
      log: () => {},
      persistence: new PostgresPersistence(url, service),
    });
    await again.ready;
    await again.close();
    assert.deepEqual(
      again.store.rows("PurchaseOrderSet").map((r) => r.PurchaseOrderId),
      order,
    );
  });

  it("persist with a postgres:// URL keeps the data there, as the service name's", async () => {
    const serviceName = fresh();
    const app = () =>
      createApp({
        modelDir: PO_MODEL,
        v4Path: "/v4",
        log: () => {},
        persist: url,
        serviceName,
      });
    const first = app();
    await first.ready;
    await first.close();
    const db = new PostgresPersistence(url, serviceName);
    const saved = await db.load();
    await db.close();
    assert.equal(
      saved?.state.PurchaseOrderSet.length,
      first.store.rows("PurchaseOrderSet").length,
    );
  });

  it("a database that can't be reached fails the start, naming it without the password", async () => {
    const u = new URL(url);
    u.port = "1";
    u.password = "hunter2";
    const db = new PostgresPersistence(u.toString(), fresh());
    await assert.rejects(db.load(), (e: Error) => {
      assert.match(e.message, /^cannot connect to postgres:\/\//);
      assert.doesNotMatch(e.message, /hunter2/);
      return true;
    });
  });

  it("a save without a connection fails, and says so", async () => {
    const db = new PostgresPersistence(url, fresh());
    await assert.rejects(db.commit([]), /is not open/);
  });
});
