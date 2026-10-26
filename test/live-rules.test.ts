import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../lib/app.ts";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  PO_MODEL,
  type TestServer,
} from "./helpers.ts";

// Live mock rules (see live-rules.ts), on PO_MODEL's metadata without its data files: its
// orders and their items are generated, an item's key holding its order's
describe("live mock rules", () => {
  let dir: string;
  let s: TestServer;
  let logged: string[];
  const config = (mock: Record<string, unknown>) =>
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ mock }));
  // What the last reload logged
  const reload = async () => {
    logged = [];
    await s.reloadRules!();
    return logged.join("\n");
  };
  const orders = () => s.store.rows("PurchaseOrderSet");
  const items = () => s.store.rows("PurchaseOrderItemSet");

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-"));
    fs.copyFileSync(
      path.join(PO_MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    logged = [];
    s = await start(dir, {
      mockRows: 5,
      watchRules: true,
      log: (m) => logged.push(m),
    });
  });
  afterEach(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("regenerates a set when its rules change, as a start with them would", async () => {
    const itemsBefore = structuredClone(items());
    config({ "PurchaseOrderSet.Status": ["Approved"] });
    assert.equal(
      await reload(),
      `${path.join(dir, "config.json")}: mock rules changed\n  PurchaseOrderSet: regenerated`,
    );
    assert.ok(orders().every((o) => o.Status === "Approved"));
    // The same rows as a start with the rule
    const fresh = createApp({ modelDir: dir, mockRows: 5, log: () => {} });
    assert.deepEqual(orders(), fresh.store.rows("PurchaseOrderSet"));
    // The items' rules didn't change, nor their rows
    assert.deepEqual(items(), itemsBefore);
    // Served at once
    const r = await get(`${s.v4}/PurchaseOrderSet?$select=Status`);
    assert.deepEqual(
      [...new Set(r.body.value.map((o: { Status: string }) => o.Status))],
      ["Approved"],
    );
  });

  it("does nothing when the rules come out the same", async () => {
    const before = structuredClone(orders());
    config({ "PurchaseOrderSet.Plant": [] }); // a mistake...
    await reload();
    config({}); // ...fixed: the rules are as they were
    assert.equal(await reload(), "");
    assert.deepEqual(orders(), before);
  });

  it("keeps a set with a write, and says so", async () => {
    const order = orders()[0].PurchaseOrderId;
    const r = await send(
      "PATCH",
      `${s.v4}/PurchaseOrderItemSet(PurchaseOrderId='${items()[0].PurchaseOrderId}',ItemPosition='${items()[0].ItemPosition}')`,
      { Description: "mine" },
    );
    assert.equal(r.status, 204);
    config({ Currency: "EUR" });
    assert.equal(
      await reload(),
      [
        `${path.join(dir, "config.json")}: mock rules changed`,
        "  PurchaseOrderSet: regenerated",
        "  PurchaseOrderItemSet: has your changes, kept (restart to regenerate it)",
      ].join("\n"),
    );
    assert.ok(orders().every((o) => o.Currency === "EUR"));
    assert.ok(items().some((i) => i.Description === "mine"));
    assert.ok(items().some((i) => i.Currency !== "EUR"));
    assert.equal(orders()[0].PurchaseOrderId, order);
  });

  it("not a write rolled back", async () => {
    // A changeset whose second request fails: its first, done, is undone
    const item = items()[0];
    const key = `PurchaseOrderId='${item.PurchaseOrderId}',ItemPosition='${item.ItemPosition}'`;
    const r = await batch(s.v4, [
      [
        {
          method: "PATCH",
          url: `PurchaseOrderItemSet(${key})`,
          body: { Description: "mine" },
        },
        {
          method: "PATCH",
          url: `PurchaseOrderItemSet(${key})`,
          body: { Quantity: "lots" },
        },
      ],
    ]);
    assert.equal(r.status, 200);
    assert.equal(batchResponses(r.text)[0].status, 400);
    assert.notEqual(items()[0].Description, "mine");
    config({ Currency: "EUR" });
    assert.match(await reload(), /PurchaseOrderItemSet: regenerated/);
  });

  it("keeps a set whose keys would change under rows that point at them", async () => {
    const before = structuredClone(orders());
    const item = items()[0];
    await send(
      "PATCH",
      `${s.v4}/PurchaseOrderItemSet(PurchaseOrderId='${item.PurchaseOrderId}',ItemPosition='${item.ItemPosition}')`,
      { Description: "mine" },
    );
    config({ "PurchaseOrderSet.PurchaseOrderId": "46########" });
    assert.equal(
      await reload(),
      [
        `${path.join(dir, "config.json")}: mock rules changed`,
        "  PurchaseOrderSet: kept, PurchaseOrderItemSet refers to it and has your changes (restart to regenerate it)",
      ].join("\n"),
    );
    assert.deepEqual(orders(), before);
  });

  it("regenerates the rows that point at a set with them, when nothing was written", async () => {
    config({ "PurchaseOrderSet.PurchaseOrderId": "46########" });
    assert.match(await reload(), /PurchaseOrderSet: regenerated/);
    const keys = new Set(orders().map((o) => o.PurchaseOrderId));
    assert.ok([...keys].every((k) => String(k).startsWith("46")));
    // Every item still has its order
    assert.ok(items().every((i) => keys.has(i.PurchaseOrderId)));
  });

  it("logs a mistake with its fix, and keeps the rows", async () => {
    const before = structuredClone(orders());
    config({ "PurchaseOrderSet.Staus": ["Open"] });
    assert.equal(
      await reload(),
      [
        `${path.join(dir, "config.json")}: a mock rule that doesn't fit the model:`,
        '  mock "PurchaseOrderSet.Staus": PurchaseOrderSet has no property Staus. Did you mean "Status"?',
        "  The rows are as they were: fix it and save again",
      ].join("\n"),
    );
    assert.deepEqual(orders(), before);
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json");
    assert.match(await reload(), /The rows are as they were/);
  });

  it("a regenerated set's delta links are gone, the others' still work", async () => {
    const tracked = async (set: string) =>
      (await get(`${s.v4}/${set}`, { prefer: "odata.track-changes" })).body[
        "@odata.deltaLink"
      ] as string;
    const orderLink = await tracked("PurchaseOrderSet");
    const itemLink = await tracked("PurchaseOrderItemSet");
    config({ "PurchaseOrderSet.Status": ["Approved"] });
    await reload();
    assert.equal((await get(s.base + orderLink)).status, 410);
    assert.equal((await get(s.base + itemLink)).status, 200);
  });

  it("follows a file config.json extends, and one written after the start", async () => {
    // Written after the start: seen by the watch on the model's folder
    const shared = path.join(dir, "shared.json");
    fs.writeFileSync(shared, JSON.stringify({ mock: {} }));
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ extends: "./shared.json" }),
    );
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 100 && !done(); i++)
        await new Promise((r) => setTimeout(r, 50));
      assert.ok(done());
    };
    logged = [];
    fs.writeFileSync(
      shared,
      JSON.stringify({ mock: { "PurchaseOrderSet.Status": ["Approved"] } }),
    );
    await until(() => orders().every((o) => o.Status === "Approved"));
    await until(() =>
      logged.some((l) => l.includes("PurchaseOrderSet: regenerated")),
    );
  });
});

describe("live mock rules: when they're off", () => {
  it("without watchRules, with persistence, or with nothing generated", async () => {
    const off = [
      createApp({ modelDir: PO_MODEL, mockRows: 5, log: () => {} }),
      createApp({
        modelDir: PO_MODEL,
        mockRows: 5,
        log: () => {},
        watchRules: true,
        persist: ":memory:",
      }),
      createApp({ modelDir: PO_MODEL, log: () => {}, watchRules: true }),
    ];
    for (const app of off) assert.equal(app.reloadRules, undefined);
    await Promise.all(off.map((app) => app.close()));
  });
});
