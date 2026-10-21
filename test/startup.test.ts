import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  PO_MODEL,
} from "./helpers.ts";
import { createApp } from "../lib/app.ts";
import { Queue } from "../lib/queue.ts";
import type { Persistence, SetChanges } from "../lib/persistence.ts";
import type { Row } from "../lib/model.ts";

const ORDERS = "PurchaseOrderSet";

// A persistence whose load answers state (after delay ms), or throws loadError; commit
// records, or throws commitError. events records loads, commits and closing in order.
function fake({
  state,
  delay = 0,
  loadError,
  commitError,
  commitDelay = 0,
}: {
  state?: Record<string, Row[]>;
  delay?: number;
  loadError?: string;
  commitError?: string;
  commitDelay?: number;
} = {}) {
  const commits: SetChanges[][] = [];
  const events: string[] = [];
  const persistence: Persistence = {
    async load() {
      await sleep(delay);
      events.push("load");
      if (loadError) throw new Error(loadError);
      return state;
    },
    async commit(changes) {
      events.push("commit start");
      await sleep(commitDelay);
      if (commitError) throw new Error(commitError);
      commits.push(changes);
      events.push("commit end");
    },
    close() {
      events.push("close");
      return Promise.resolve();
    },
  };
  return { persistence, commits, events };
}

const app = (persistence?: Persistence) =>
  createApp({ modelDir: PO_MODEL, v4Path: "/v4", log: () => {}, persistence });

describe("Queue that starts behind ready", () => {
  it("runs tasks once ready has settled, and fails them with its error", async () => {
    let open!: () => void;
    const ready = new Promise<void>((resolve) => (open = resolve));
    const events: string[] = [];
    const queue = new Queue(ready);
    const task = queue.run(() => events.push("task"));
    await sleep(10);
    assert.deepEqual(events, []);
    open();
    await task;
    assert.deepEqual(events, ["task"]);

    const failed = new Queue(Promise.reject(new Error("no state")));
    await assert.rejects(
      failed.run(() => "never"),
      /no state/,
    );
    await failed.idle();
  });
});

describe("Startup with persistence", () => {
  it("without persistence: ready at once, and changes allowed outside a transaction", async () => {
    const built = app();
    await built.ready;
    assert.equal(built.store.transactionsOnly, false);
    await built.close();
  });

  it("with no saved state: saves the seeded one first, every row of every set", async () => {
    const f = fake();
    const built = app(f.persistence);
    await built.ready;
    assert.equal(f.commits.length, 1);
    const saved = Object.fromEntries(
      f.commits[0].map((c) => [c.set, c.written.length]),
    );
    const seeded = Object.fromEntries(
      Object.entries(built.store.sets()).map(([set, rows]) => [
        set,
        rows.length,
      ]),
    );
    assert.deepEqual(saved, seeded);
    assert.ok(saved[ORDERS] > 0);
  });

  it("then every change must be in a transaction", async () => {
    const f = fake();
    const built = app(f.persistence);
    await built.ready;
    assert.equal(built.store.transactionsOnly, true);
    const [order] = built.store.rows(ORDERS);
    assert.throws(
      () => built.store.update(ORDERS, order, { Status: "Outside" }),
      /outside a transaction/,
    );
  });

  it("with a saved state: it replaces the seeded rows of the sets it has", async () => {
    const built = app();
    const [order] = built.store.rows(ORDERS);
    const items = built.store.rows("PurchaseOrderItemSet").length;
    const f = fake({
      state: {
        [ORDERS]: [{ ...order, PurchaseOrderId: "SAVED1", Status: "Saved" }],
        Removed: [{ x: 1 }], // a set the metadata no longer has
      },
    });
    const s = await start(PO_MODEL, { persistence: f.persistence });
    try {
      await s.ready;
      assert.deepEqual(f.commits, []); // nothing to save: the state is the saved one
      const orders = await get(`${s.v4}/${ORDERS}`);
      assert.deepEqual(
        orders.body.value.map((o: Row) => o.PurchaseOrderId),
        ["SAVED1"],
      );
      assert.equal(s.store.rows("PurchaseOrderItemSet").length, items);
      assert.equal(s.store.sets().Removed, undefined);
    } finally {
      await s.close();
    }
  });

  it("a request sent before the state is loaded waits for it", async () => {
    const [order] = app().store.rows(ORDERS);
    const f = fake({
      delay: 100,
      state: { [ORDERS]: [{ ...order, Status: "Loaded" }] },
    });
    const s = await start(PO_MODEL, { persistence: f.persistence });
    try {
      const read = await get(`${s.v4}/${ORDERS}('${order.PurchaseOrderId}')`);
      assert.equal(read.body.Status, "Loaded");
      assert.deepEqual(f.events, ["load"]);
    } finally {
      await s.close();
    }
  });

  it("a state that can't be loaded: ready rejects, and every request is a 503", async () => {
    const f = fake({ loadError: "file is corrupt" });
    const s = await start(PO_MODEL, { persistence: f.persistence });
    try {
      await assert.rejects(s.ready, /could not be loaded: file is corrupt/);
      const read = await get(`${s.v4}/${ORDERS}`);
      assert.equal(read.status, 503);
      assert.match(read.body.error.message, /could not be loaded/);
      const write = await send("PATCH", `${s.v4}/${ORDERS}('4500000001')`, {
        Status: "x",
      });
      assert.equal(write.status, 503);
      const r = await batch(s.v4, [{ method: "GET", url: ORDERS }]);
      assert.equal(r.status, 503);
      assert.deepEqual(batchResponses(r.text), []);
    } finally {
      await s.close();
    }
  });

  it("a first state that can't be saved: ready rejects too", async () => {
    const f = fake({ commitError: "read-only" });
    const built = app(f.persistence);
    await assert.rejects(
      built.ready,
      /first state could not be saved: read-only/,
    );
  });
});

describe("Closing", () => {
  // A server of its own: the helpers' close() drops open connections, which would cut off the
  // request the test waits for
  it("waits for the requests in the queue, and their saves, then closes persistence", async () => {
    const f = fake({ commitDelay: 50 });
    const built = app(f.persistence);
    await built.ready;
    f.events.length = 0;
    const server = built.app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const write = send(
        "PATCH",
        `http://127.0.0.1:${port}/v4/${ORDERS}('4500000001')`,
        { Status: "Before close" },
      );
      while (!f.events.includes("commit start")) await sleep(1);
      await built.close();
      assert.deepEqual(f.events, ["commit start", "commit end", "close"]);
      assert.equal((await write).status, 204);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
