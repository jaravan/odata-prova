import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { start, get, send, ORDER, PO_MODEL, SALES_MODEL } from "./helpers.ts";
import { SharedDatabase, SharedPersistence } from "./memory-persistence.ts";
import { sharedTurn } from "../lib/persistence.ts";

// Servers sharing one saved state (see sharedTurn in persistence.ts), on a database in memory:
// each catches up with what the others saved before every request. What only PostgreSQL has
// to get right (its log, its locks, its connections) is in postgres.test.ts.

// Servers on one database, started one after the other
async function servers(db: SharedDatabase, n = 2, modelDir = PO_MODEL) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const persistence = new SharedPersistence(db);
    const s = await start(modelDir, { persistence });
    await s.ready;
    out.push({ s, persistence });
  }
  return out;
}

const order = (id: string) => `PurchaseOrderSet('${id}')`;

describe("servers sharing a saved state", () => {
  it("a write on one is read on the other, at once", async () => {
    const db = new SharedDatabase();
    const [a, b] = await servers(db);
    try {
      assert.equal(
        (
          await send("PATCH", `${a.s.v4}/${order("4500000001")}`, {
            Status: "Shared",
          })
        ).status,
        204,
      );
      assert.equal(
        (await get(`${b.s.v4}/${order("4500000001")}`)).body.Status,
        "Shared",
      );
      await send("POST", `${b.s.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: "S1",
      });
      await send("DELETE", `${b.s.v4}/${order("4500000002")}`);
      assert.equal((await get(`${a.s.v4}/${order("S1")}`)).status, 200);
      assert.equal((await get(`${a.s.v4}/${order("4500000002")}`)).status, 404);
      // In the same order on both: a new row last
      assert.deepEqual(
        a.s.store.rows("PurchaseOrderSet"),
        b.s.store.rows("PurchaseOrderSet"),
      );
    } finally {
      await a.s.close();
      await b.s.close();
    }
  });

  it("a key taken on one is taken on the other", async () => {
    const db = new SharedDatabase();
    const [a, b] = await servers(db);
    try {
      const body = { ...ORDER, PurchaseOrderId: "S2" };
      assert.equal(
        (await send("POST", `${a.s.v4}/PurchaseOrderSet`, body)).status,
        201,
      );
      assert.equal(
        (await send("POST", `${b.s.v4}/PurchaseOrderSet`, body)).status,
        409,
      );
    } finally {
      await a.s.close();
      await b.s.close();
    }
  });

  it("the first to start seeds the state, and the others load it", async () => {
    const db = new SharedDatabase();
    const logs: string[] = [];
    const a = await start(PO_MODEL, {
      persistence: new SharedPersistence(db),
    });
    // Started before the first saved: it finds nothing, and its own first state is refused
    const late = new SharedPersistence(db);
    const b = await start(PO_MODEL, {
      persistence: late,
      log: (m) => logs.push(m),
    });
    try {
      await a.ready;
      await b.ready;
      assert.ok(
        logs.some((m) => /saved first by another server/.test(m)),
        logs.join("\n"),
      );
      assert.equal(db.log.length, 1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a turn not expected to write, that does, runs again when another server saved first", async () => {
    const db = new SharedDatabase();
    const [a, b] = await servers(db);
    try {
      // Another server's commit, between b's catching up and b's commit
      db.between = () =>
        db.save([
          {
            set: "PurchaseOrderSet",
            written: [
              {
                key: JSON.stringify(["4500000003"]),
                row: {
                  ...a.s.store.rows("PurchaseOrderSet")[2],
                  Status: "Elsewhere",
                },
              },
            ],
            deleted: [],
          },
        ]);
      const service = b.s.services.find((svc) =>
        svc.servicePath.endsWith("v4/T"),
      )!;
      const calls = b.persistence.sinceCalls;
      const r = await sharedTurn(
        b.persistence,
        b.s.store,
        () =>
          service.execute(
            "PATCH",
            `${service.servicePath}/${order("4500000001")}`,
            {},
            {
              Status: "Retried",
            },
          ),
        false,
      );
      assert.equal(r.status, 204);
      assert.equal(b.persistence.sinceCalls - calls, 2);
      const rows = b.s.store.rows("PurchaseOrderSet");
      assert.equal(rows[0].Status, "Retried");
      assert.equal(rows[2].Status, "Elsewhere");
    } finally {
      await a.s.close();
      await b.s.close();
    }
  });

  it("a write whose turn is overtaken anyway is a 503, and nothing changes", async () => {
    const db = new SharedDatabase();
    const [a] = await servers(db, 1);
    try {
      db.between = () => db.save([]);
      const r = await send("PATCH", `${a.s.v4}/${order("4500000001")}`, {
        Status: "Lost",
      });
      assert.equal(r.status, 503);
      assert.match(r.body.error.message, /send the request again/);
      assert.notEqual(
        (await get(`${a.s.v4}/${order("4500000001")}`)).body.Status,
        "Lost",
      );
    } finally {
      await a.s.close();
    }
  });

  it("a state replaced from another metadata.xml stops the others: 503, to restart", async () => {
    const db = new SharedDatabase();
    const [a] = await servers(db, 1);
    const [other] = await servers(db, 1, SALES_MODEL).catch(() => [undefined]);
    try {
      // The other model's server adapted the state to its metadata.xml, and replaced it
      assert.ok(other);
      const r = await get(`${a.s.v4}/PurchaseOrderSet`);
      assert.equal(r.status, 503);
      assert.match(r.body.error.message, /another metadata\.xml: restart/);
    } finally {
      await a.s.close();
      await other?.s.close();
    }
  });

  it("a state replaced by a reset is loaded again by the others", async () => {
    const db = new SharedDatabase();
    const [a, b] = await servers(db);
    try {
      await send("POST", `${a.s.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: "S3",
      });
      assert.equal((await get(`${b.s.v4}/${order("S3")}`)).status, 200);
      const reset = await start(PO_MODEL, {
        persistence: new SharedPersistence(db),
        persistReset: true,
      });
      await reset.ready;
      await reset.close();
      assert.equal((await get(`${b.s.v4}/${order("S3")}`)).status, 404);
    } finally {
      await a.s.close();
      await b.s.close();
    }
  });
});
