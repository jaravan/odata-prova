import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  ORDER,
  ITEM,
  PO_MODEL,
} from "./helpers.ts";
import { MemoryPersistence } from "./memory-persistence.ts";
import { createApp } from "../lib/app.ts";
import { everything } from "../lib/persistence.ts";
import type { Persistence, SetChanges, Shape } from "../lib/persistence.ts";
import { SqlitePersistence } from "../lib/sqlite.ts";
import { PostgresPersistence } from "../lib/postgres.ts";
import type { Model, Row } from "../lib/model.ts";

// Every kind of write, each followed by the same check: what persistence holds is what the
// store holds, row for row. Then a restart: a new app on what was saved sees all of it. Run
// against every backend: the in-memory one the others are measured by, SQLite, and
// PostgreSQL when POSTGRES_URL names one (yarn test:postgres starts one in Docker).

const FIXTURES = path.join(import.meta.dirname, "fixtures");

type Saving = Persistence & {
  state(): Record<string, Row[]> | Promise<Record<string, Row[]>>;
};

const POSTGRES_URL = process.env.POSTGRES_URL;

// A backend for a test, wrapped to count its commits, and to make every call take delay ms
function counted(p: Saving, delay = 0) {
  const db = {
    commits: 0,
    async load(model: Model) {
      await sleep(delay);
      return p.load(model);
    },
    async commit(changes: SetChanges[]) {
      await sleep(delay);
      await p.commit(changes);
      db.commits++;
    },
    async replace(changes: SetChanges[], shape: Shape) {
      await sleep(delay);
      await p.replace(changes, shape);
      db.commits++;
    },
    close: () => p.close(),
    state: () => p.state(),
  };
  return db;
}

// open(): the backend for one test, reopen() the same saved state for a restart (once the
// first is closed: a SQLite file is locked while open), emptySet() a set in what's saved
const BACKENDS = [
  {
    name: "memory",
    open(delay = 0) {
      const m = new MemoryPersistence();
      return {
        db: counted(m, delay),
        reopen: () => counted(m),
        emptySet: (set: string) => {
          m.saved!.get(set)!.clear();
          return Promise.resolve();
        },
        done: () => {},
      };
    },
  },
  {
    name: "sqlite",
    open(delay = 0) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-"));
      const file = path.join(dir, "state.db");
      return {
        db: counted(new SqlitePersistence(file), delay),
        reopen: () => counted(new SqlitePersistence(file)),
        async emptySet(set: string) {
          const { DatabaseSync } = await import("node:sqlite");
          const db = new DatabaseSync(file);
          db.prepare("DELETE FROM rows WHERE set_name = ?").run(set);
          db.close();
        },
        done: () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
  ...(POSTGRES_URL ? [postgresBackend(POSTGRES_URL)] : []),
];

// Each test a service of its own in the database, so they don't see each other's rows
function postgresBackend(url: string) {
  return {
    name: "postgres",
    open(delay = 0) {
      const service = `test-${randomUUID()}`;
      return {
        db: counted(new PostgresPersistence(url, service), delay),
        reopen: () => counted(new PostgresPersistence(url, service)),
        emptySet: async (set: string) => {
          const { default: pg } = await import("pg");
          const client = new pg.Client({ connectionString: url });
          await client.connect();
          await client.query(
            "DELETE FROM odata_prova_rows WHERE service = $1 AND set_name = $2",
            [service, set],
          );
          await client.end();
        },
        done: () => {},
      };
    },
  };
}
type Backend = (typeof BACKENDS)[number];

// Each set's rows by identity, as persistence keys them
function byKey(model: Model, sets: Readonly<Record<string, readonly Row[]>>) {
  return Object.fromEntries(
    everything(model, sets).map(({ set, written }) => [
      set,
      Object.fromEntries(written.map(({ key, row }) => [key, row])),
    ]),
  );
}

// A server on modelDir with the backend, started; mirrored() asserts that what it saved is
// what the store holds
async function serve(backend: Backend, modelDir: string, delay = 0) {
  const { db, reopen, done } = backend.open(delay);
  const s = await start(modelDir, { persistence: db });
  await s.ready;
  const mirrored = async () =>
    assert.deepEqual(
      byKey(s.model, await db.state()),
      byKey(s.model, s.store.sets()),
    );
  // Sends a request, checks the answer's status, then that the store and what's saved agree
  const step = async (
    expected: number,
    request: Promise<{ status: number; body?: unknown }>,
  ) => {
    const r = await request;
    assert.equal(r.status, expected, JSON.stringify(r.body));
    await mirrored();
    return r;
  };
  // Stops this server, and starts a new app on what it saved: its store holds what this
  // one's did. Returns the new app, closed.
  const restarted = async () => {
    const before = byKey(s.model, s.store.sets());
    await s.close();
    const again = createApp({
      modelDir,
      v4Path: "/v4",
      log: () => {},
      persistence: reopen(),
    });
    await again.ready;
    await again.close();
    assert.deepEqual(byKey(s.model, again.store.sets()), before);
    return again;
  };
  const close = async () => {
    await s.close();
    done();
  };
  return { s, db, mirrored, step, restarted, close };
}

for (const backend of BACKENDS) {
  describe(`persistence (${backend.name}): every kind of write is saved as the store holds it`, () => {
    it("creates, deep inserts, updates, replaces and deletes; a refused write saves nothing", async () => {
      const { s, db, step, restarted, close } = await serve(backend, PO_MODEL);
      try {
        const orders = `${s.v4}/PurchaseOrderSet`;
        await step(
          201,
          send("POST", orders, { ...ORDER, PurchaseOrderId: "P1" }),
        );
        await step(
          201,
          send("POST", orders, {
            ...ORDER,
            PurchaseOrderId: "P2",
            Items: [
              { ...ITEM, ItemPosition: "0010" },
              { ...ITEM, ItemPosition: "0020" },
            ],
          }),
        );
        await step(
          204,
          send("PATCH", `${orders}('P1')`, { Status: "Patched" }),
        );
        await step(
          204,
          send("PUT", `${orders}('P1')`, { ...ORDER, Supplier: "Put" }),
        );
        await step(
          204,
          send(
            "DELETE",
            `${s.v4}/PurchaseOrderItemSet(PurchaseOrderId='P2',ItemPosition='0010')`,
          ),
        );
        await step(204, send("DELETE", `${orders}('P1')`));
        const commits = db.commits;
        await step(400, send("PATCH", `${orders}('P2')`, { Status: null }));
        await step(200, get(`${orders}?$expand=Items`));
        assert.equal(db.commits, commits);

        const again = await restarted();
        assert.equal(
          again.store
            .rows("PurchaseOrderSet")
            .some((o) => o.PurchaseOrderId === "P1"),
          false,
        );
      } finally {
        await close();
      }
    });

    it("a V2 MERGE, and a changeset with a Content-ID reference, saved as one", async () => {
      const { s, db, step, restarted, close } = await serve(backend, PO_MODEL);
      try {
        await step(
          204,
          send("MERGE", `${s.v2}/PurchaseOrderSet('4500000001')`, {
            Status: "Merged",
          }),
        );
        const commits = db.commits;
        const r = await step(
          200,
          batch(s.v4, [
            [
              {
                method: "POST",
                url: "PurchaseOrderSet",
                body: { ...ORDER, PurchaseOrderId: "B1" },
                contentId: "1",
              },
              {
                method: "POST",
                url: "$1/Items",
                body: { ...ITEM, ItemPosition: "0001" },
              },
              {
                method: "PATCH",
                url: "PurchaseOrderSet('4500000002')",
                body: { Status: "In batch" },
              },
            ],
          ]).then((b) => ({ status: b.status, body: b.text })),
        );
        assert.deepEqual(
          batchResponses(r.body as string).map((p) => p.status),
          [201, 201, 204],
        );
        assert.equal(db.commits, commits + 1);
        await restarted();
      } finally {
        await close();
      }
    });

    it("links: @odata.bind, $ref and V2 $links on a link set", async () => {
      const { s, step, restarted, close } = await serve(
        backend,
        path.join(FIXTURES, "ManyToMany"),
      );
      try {
        await step(
          201,
          send("POST", `${s.v4}/Students`, {
            StudentId: 5,
            "Courses@odata.bind": ["Courses(10)", "Courses(20)"],
          }),
        );
        await step(
          204,
          send("POST", `${s.v4}/Students(2)/Courses/$ref`, {
            "@odata.id": "Courses(20)",
          }),
        );
        await step(204, send("DELETE", `${s.v4}/Students(1)/Courses(10)/$ref`));
        await step(
          204,
          send("DELETE", `${s.v2}/Students(2)/$links/Courses(10)`),
        );
        await step(204, send("DELETE", `${s.v4}/Students(5)`));
        await restarted();
      } finally {
        await close();
      }
    });

    it("a contained entity, created under its parent", async () => {
      const { s, step, restarted, close } = await serve(
        backend,
        path.join(FIXTURES, "Containment"),
      );
      try {
        await step(
          201,
          send("POST", `${s.v4}/People('ben')/Trips`, {
            TripId: 2,
            Name: "Lisbon",
          }),
        );
        await step(
          204,
          send("PATCH", `${s.v4}/People('ben')/Trips(2)`, { Name: "Porto" }),
        );
        const again = await restarted();
        assert.equal(
          again.store
            .rows("People-Trips")
            .find((t) => t.Person_UserName === "ben" && t.TripId === 2)?.Name,
          "Porto",
        );
      } finally {
        await close();
      }
    });

    it("drafts: new, changed, activated; edited and discarded", async () => {
      const { s, step, restarted, close } = await serve(
        backend,
        path.join(FIXTURES, "DraftSrv"),
      );
      try {
        const ACTION = (name: string) => `CatalogService.${name}`;
        const created = await step(
          201,
          send("POST", `${s.v4}/Books`, { title: "Draft" }),
        );
        const id = (created.body as { ID: string }).ID;
        const draft = `${s.v4}/Books(ID=${id},IsActiveEntity=false)`;
        await step(201, send("POST", `${draft}/chapters`, { title: "One" }));
        await step(204, send("PATCH", draft, { title: "Changed" }));
        await step(
          200,
          send("POST", `${draft}/${ACTION("draftActivate")}`, {}),
        );

        const BOOK = "b0000000-0000-4000-8000-000000000001";
        const active = `${s.v4}/Books(ID=${BOOK},IsActiveEntity=true)`;
        await step(200, send("POST", `${active}/${ACTION("draftEdit")}`, {}));
        await step(
          204,
          send("DELETE", `${s.v4}/Books(ID=${BOOK},IsActiveEntity=false)`),
        );
        const again = await restarted();
        assert.equal(again.store.rows("$DraftAdministrativeData").length, 0);
      } finally {
        await close();
      }
    });

    it("an action's rule, and the new ETag it gives", async () => {
      const { s, step, restarted, close } = await serve(
        backend,
        path.join(FIXTURES, "ETagSrv"),
      );
      try {
        const r = await step(
          200,
          send("POST", `${s.v4}/Books(2)/ETagSrv.approve`, {}),
        );
        assert.equal((r.body as { status: string }).status, "approved");
        await restarted();
      } finally {
        await close();
      }
    });

    it("a GET function whose rule changes data: a read that writes is saved too", async () => {
      // OperationsV2 with ApprovePurchaseOrder called by GET, and a rule for it
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "get-rule-"));
      try {
        const from = path.join(FIXTURES, "OperationsV2");
        fs.cpSync(from, dir, { recursive: true });
        const xml = fs.readFileSync(path.join(dir, "metadata.xml"), "utf8");
        fs.writeFileSync(
          path.join(dir, "metadata.xml"),
          xml.replace(
            /(Name="ApprovePurchaseOrder"[^>]*)m:HttpMethod="POST"/,
            '$1m:HttpMethod="GET"',
          ),
        );
        fs.writeFileSync(
          path.join(dir, "config.json"),
          JSON.stringify({
            operations: {
              ApprovePurchaseOrder: { set: { Status: "Approved" } },
            },
          }),
        );
        const { s, db, step, restarted, close } = await serve(backend, dir);
        try {
          const commits = db.commits;
          await step(
            200,
            get(`${s.v2}/ApprovePurchaseOrder?PurchaseOrderId='4500000001'`),
          );
          assert.equal(db.commits, commits + 1);
          const again = await restarted();
          assert.equal(
            again.store
              .rows("PurchaseOrderSet")
              .find((o) => o.PurchaseOrderId === "4500000001")?.Status,
            "Approved",
          );
        } finally {
          await close();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe(`persistence (${backend.name}): restarts`, () => {
    it("a restart keeps the writes, and further writes are saved on top", async () => {
      const { db, reopen, done } = backend.open();
      const first = await start(PO_MODEL, { persistence: db });
      await first.ready;
      await send("POST", `${first.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: "R1",
      });
      await first.close();

      const again = reopen();
      const second = await start(PO_MODEL, { persistence: again });
      try {
        await second.ready;
        assert.equal(
          (await get(`${second.v4}/PurchaseOrderSet('R1')`)).status,
          200,
        );
        await send("PATCH", `${second.v4}/PurchaseOrderSet('R1')`, {
          Status: "Again",
        });
        assert.equal(
          (await again.state()).PurchaseOrderSet.find(
            (o) => o.PurchaseOrderId === "R1",
          )?.Status,
          "Again",
        );
      } finally {
        await second.close();
        done();
      }
    });

    it("generated rows are saved at the first start, and loaded, not generated again, after", async () => {
      const { db, reopen, emptySet, done } = backend.open();
      const dir = path.join(FIXTURES, "SapAnnotationsV2"); // no data files
      const app = (persistence: Persistence) =>
        createApp({
          modelDir: dir,
          v4Path: "/v4",
          log: () => {},
          mockRows: 5,
          persistence,
        });
      try {
        const first = app(db);
        await first.ready;
        const generated = first.store.generated;
        assert.ok(generated.length > 0, "a set without a data file");
        for (const set of generated)
          assert.equal(
            (await db.state())[set].length,
            first.store.rows(set).length,
          );
        await first.close();
        // Generating is deterministic, so the same rows again prove nothing: empty one set in
        // what was saved, and the second start has to come up with it empty
        const [emptied, ...kept] = generated;
        await emptySet(emptied);
        const second = app(reopen());
        await second.ready;
        await second.close();
        assert.deepEqual(second.store.rows(emptied), []);
        for (const set of kept)
          assert.deepEqual(second.store.rows(set), first.store.rows(set));
      } finally {
        done();
      }
    });

    it("with an async backend, requests piling up in the queue are all saved, in order", async () => {
      const { s, step, restarted, close } = await serve(backend, PO_MODEL, 15);
      try {
        const url = `${s.v4}/PurchaseOrderSet('4500000001')`;
        const writes = ["a", "b", "c", "d"].map((v) =>
          send("PATCH", url, { Supplier: v }),
        );
        for (const w of writes) assert.equal((await w).status, 204);
        await step(200, get(url));
        await restarted();
      } finally {
        await close();
      }
    });
  });
}
