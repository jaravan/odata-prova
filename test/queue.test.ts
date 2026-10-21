import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { start, get, send, batch, batchResponses, ORDER } from "./helpers.ts";
import { Queue } from "../lib/queue.ts";
import type { Persistence, SetChanges } from "../lib/persistence.ts";

// A persistence that keeps what it's given: each commit takes delay ms, and throws while
// failing is set. events records when commits start and end, for the tests to order against.
function fake({ delay = 0 }: { delay?: number } = {}) {
  const commits: SetChanges[][] = [];
  const events: string[] = [];
  const state = { failing: false };
  const persistence: Persistence = {
    load: () => Promise.resolve(undefined),
    async commit(changes) {
      events.push("commit start");
      await sleep(delay);
      if (state.failing) {
        events.push("commit failed");
        throw new Error("disk full");
      }
      commits.push(changes);
      events.push("commit end");
    },
    close: () => Promise.resolve(),
  };
  // Settles once a commit has started saving: a request sent then queues behind it
  const saving = async () => {
    while (!events.includes("commit start")) await sleep(1);
  };
  // Forgets the first state saved at startup, for a test to count its own commits
  const reset = () => {
    commits.length = 0;
    events.length = 0;
  };
  return { persistence, commits, events, saving, reset, state };
}

// A server on PO_MODEL with f as its persistence, started: the first state saved, forgotten
async function serve(f: ReturnType<typeof fake>) {
  const s = await start(undefined, { persistence: f.persistence });
  await s.ready;
  f.reset();
  return s;
}

const ORDER_URL = (v4: string) => `${v4}/PurchaseOrderSet('4500000001')`;

describe("Queue", () => {
  it("runs tasks one at a time, in order, past a failing one", async () => {
    const queue = new Queue();
    const events: string[] = [];
    const task =
      (name: string, ms: number, fails = false) =>
      async () => {
        events.push(`${name} start`);
        await sleep(ms);
        events.push(`${name} end`);
        if (fails) throw new Error(name);
        return name;
      };
    const results = await Promise.allSettled([
      queue.run(task("a", 20)),
      queue.run(task("b", 0, true)),
      queue.run(() => "c"),
    ]);
    assert.deepEqual(events, ["a start", "a end", "b start", "b end"]);
    assert.deepEqual(
      results.map((r) => r.status),
      ["fulfilled", "rejected", "fulfilled"],
    );
    assert.equal((results[2] as PromiseFulfilledResult<string>).value, "c");
  });
});

describe("Requests around an async commit", () => {
  it("a read sent while a commit is saved waits for it, and sees it", async () => {
    const f = fake({ delay: 100 });
    const s = await serve(f);
    try {
      const write = send("PATCH", ORDER_URL(s.v4), { Status: "Saved" });
      await f.saving();
      const read = get(ORDER_URL(s.v4)).then((r) => {
        f.events.push("read answered");
        return r;
      });
      assert.equal((await write).status, 204);
      assert.equal((await read).body.Status, "Saved");
      assert.deepEqual(f.events, [
        "commit start",
        "commit end",
        "read answered",
      ]);
    } finally {
      await s.close();
    }
  });

  it("a failed save answers 500 and undoes the request; a read waiting sees it undone", async () => {
    const f = fake({ delay: 100 });
    const s = await serve(f);
    f.state.failing = true;
    try {
      const before = (await get(ORDER_URL(s.v4))).body.Status;
      const write = send("PATCH", ORDER_URL(s.v4), { Status: "Lost" });
      await f.saving();
      const read = get(ORDER_URL(s.v4));
      const failed = await write;
      assert.equal(failed.status, 500);
      assert.match(failed.body.error.message, /could not be saved: disk full/);
      assert.equal((await read).body.Status, before);
      assert.deepEqual(f.commits, []);
    } finally {
      await s.close();
    }
  });

  it("the next write is saved on top of the state before a failed one", async () => {
    const f = fake();
    const s = await serve(f);
    f.state.failing = true;
    try {
      const original = (await get(ORDER_URL(s.v4))).body;
      assert.equal(
        (await send("PATCH", ORDER_URL(s.v4), { Status: "Lost" })).status,
        500,
      );
      f.state.failing = false;
      assert.equal(
        (await send("PATCH", ORDER_URL(s.v4), { Supplier: "Kept" })).status,
        204,
      );
      const [[{ written }]] = f.commits;
      assert.equal(written[0].row.Supplier, "Kept");
      assert.equal(written[0].row.Status, original.Status);
    } finally {
      await s.close();
    }
  });

  it("a read, or a write that fails, saves nothing", async () => {
    const f = fake();
    const s = await serve(f);
    try {
      await get(`${s.v4}/PurchaseOrderSet`);
      const refused = await send("PATCH", ORDER_URL(s.v4), {
        Status: null,
      });
      assert.equal(refused.status, 400);
      assert.deepEqual(f.events, []);
    } finally {
      await s.close();
    }
  });
});

describe("$batch around an async commit", () => {
  it("saves a changeset once, with all its changes", async () => {
    const f = fake({ delay: 20 });
    const s = await serve(f);
    try {
      const r = await batch(s.v4, [
        [
          {
            method: "POST",
            url: "PurchaseOrderSet",
            body: { ...ORDER, PurchaseOrderId: "Q1" },
          },
          {
            method: "PATCH",
            url: "PurchaseOrderSet('4500000001')",
            body: { Status: "Batched" },
          },
        ],
      ]);
      assert.deepEqual(
        batchResponses(r.text).map((p) => p.status),
        [201, 204],
      );
      assert.equal(f.commits.length, 1);
      assert.deepEqual(f.commits[0][0].written.map((w) => w.key).sort(), [
        '["4500000001"]',
        '["Q1"]',
      ]);
    } finally {
      await s.close();
    }
  });

  it("a changeset that can't be saved answers as a failed one, and changes nothing", async () => {
    const f = fake();
    const s = await serve(f);
    f.state.failing = true;
    try {
      const r = await batch(s.v4, [
        [
          {
            method: "POST",
            url: "PurchaseOrderSet",
            body: { ...ORDER, PurchaseOrderId: "Q2" },
          },
        ],
      ]);
      const [part] = batchResponses(r.text);
      assert.equal(part.status, 500);
      assert.match(part.body.error.message, /could not be saved/);
      assert.equal((await get(`${s.v4}/PurchaseOrderSet('Q2')`)).status, 404);
    } finally {
      await s.close();
    }
  });

  it("saves each part outside a changeset before the next runs", async () => {
    const f = fake({ delay: 20 });
    const s = await serve(f);
    try {
      const r = await batch(s.v4, [
        {
          method: "PATCH",
          url: "PurchaseOrderSet('4500000001')",
          body: { Status: "First" },
        },
        { method: "GET", url: "PurchaseOrderSet('4500000001')" },
        {
          method: "PATCH",
          url: "PurchaseOrderSet('4500000001')",
          body: { Supplier: "Second" },
        },
      ]);
      const parts = batchResponses(r.text);
      assert.deepEqual(
        parts.map((p) => p.status),
        [204, 200, 204],
      );
      assert.equal(parts[1].body.Status, "First");
      assert.deepEqual(f.events, [
        "commit start",
        "commit end",
        "commit start",
        "commit end",
      ]);
      assert.equal(f.commits[1][0].written[0].row.Status, "First");
    } finally {
      await s.close();
    }
  });
});
