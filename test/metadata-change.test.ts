import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start, send, PO_MODEL } from "./helpers.ts";
import { createApp } from "../lib/app.ts";
import { SqlitePersistence } from "../lib/sqlite.ts";
import { open, shapeOf } from "../lib/persistence.ts";
import { MemoryPersistence } from "./memory-persistence.ts";

// A metadata.xml changed since the state was saved: the saved rows are adapted to it, or, when
// they'd be other rows (their keys changed), the start is refused.

let dir: string;
let file: string;
const metadata = () => path.join(dir, "model", "metadata.xml");
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "metadata-change-"));
  fs.cpSync(PO_MODEL, path.join(dir, "model"), { recursive: true });
  file = path.join(dir, "state.db");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function edit(replacements: [RegExp | string, string][]) {
  let xml = fs.readFileSync(metadata(), "utf8");
  for (const [from, to] of replacements) {
    assert.ok(xml.match(from), `metadata.xml has ${String(from)}`);
    xml = xml.replace(from, to);
  }
  fs.writeFileSync(metadata(), xml);
}

// An app on the edited model and the file, started and closed; its log lines
async function restart() {
  const logs: string[] = [];
  const app = createApp({
    modelDir: path.join(dir, "model"),
    v4Path: "/v4",
    log: (m) => logs.push(m),
    persistence: new SqlitePersistence(file),
  });
  try {
    await app.ready;
  } finally {
    await app.close();
  }
  return { app, logs };
}

const order = (app: Awaited<ReturnType<typeof restart>>["app"], id: string) =>
  app.store.rows("PurchaseOrderSet").find((o) => o.PurchaseOrderId === id)!;

describe("a metadata.xml changed since the state was saved", () => {
  it("adapts the rows: dropped, new, converted, emptied, and logs it", async () => {
    const s = await start(path.join(dir, "model"), {
      persistence: new SqlitePersistence(file),
    });
    try {
      await s.ready;
      await send("PATCH", `${s.v4}/PurchaseOrderSet('4500000001')`, {
        Currency: "USD",
      });
      // A value only the saved state holds, which an Int32 can't: the seed files must still
      // fit the metadata, as they're read (and the store seeded) before the state is loaded
      await send("PATCH", `${s.v4}/PurchaseOrderSet('4500000002')`, {
        CompanyCode: "AB",
      });
    } finally {
      await s.close();
    }
    edit([
      [/<Property Name="Supplier"[^>]*\/>\s*/, ""],
      [
        /<Property Name="CompanyCode" Type="Edm.String"/,
        '<Property Name="CompanyCode" Type="Edm.Int32"',
      ],
      [
        /(<Property Name="Currency"[^>]*\/>)/,
        '$1<Property Name="Remarks" Type="Edm.String"/>',
      ],
    ]);

    const { app, logs } = await restart();
    const adapted = order(app, "4500000001");
    assert.equal(adapted.Currency, "USD", "the write before the change stays");
    assert.equal("Supplier" in adapted, false);
    assert.equal(adapted.CompanyCode, 1000);
    assert.equal(adapted.Remarks, null);
    assert.equal(order(app, "4500000002").CompanyCode, null); // "AB" isn't an Int32
    assert.deepEqual(
      logs.slice(
        logs.indexOf("The metadata changed since the state was saved:"),
      ),
      [
        "The metadata changed since the state was saved:",
        "  PurchaseOrderSet: Supplier no longer in the metadata, dropped",
        "  PurchaseOrderSet: Remarks new, empty",
        "  PurchaseOrderSet: CompanyCode from Edm.String to Edm.Int32",
        "  PurchaseOrderSet: 1 value couldn't be converted, emptied",
      ],
    );

    // Saved as adapted, with the new shape: the next start has nothing to adapt
    const next = await restart();
    assert.equal(
      next.logs.some((l) => l.startsWith("The metadata changed")),
      false,
    );
    assert.deepEqual(order(next.app, "4500000001"), adapted);
  });

  it("seeds a set that's new in the metadata", async () => {
    await restart();
    edit([
      [
        /(<EntitySet Name="PurchaseOrderSet"[^>]*\/>)/,
        '$1<EntitySet Name="ArchiveSet" EntityType="com.example.po.PurchaseOrder"/>',
      ],
    ]);
    const { app, logs } = await restart();
    assert.ok(logs.includes("  ArchiveSet: new in the metadata, seeded"));
    assert.deepEqual(app.store.rows("ArchiveSet"), []);
  });

  it("refuses to start when a set's keys changed: the rows would be other rows", async () => {
    await restart();
    edit([
      [
        '<PropertyRef Name="PurchaseOrderId"/>\n        </Key>\n        <Property Name="PurchaseOrderId"',
        '<PropertyRef Name="PurchaseOrderId"/><PropertyRef Name="CompanyCode"/>\n        </Key>\n        <Property Name="PurchaseOrderId"',
      ],
    ]);
    await assert.rejects(
      restart(),
      /could not be used: PurchaseOrderSet's rows are told apart by PurchaseOrderId, CompanyCode now, by PurchaseOrderId when they were saved: start over with --persist-reset/,
    );
  });

  it("refuses too when a key's type changed", async () => {
    await restart();
    edit([
      [
        /<Property Name="PurchaseOrderId" Type="Edm.String" Nullable="false" MaxLength="10"\/>\s*<Property Name="Supplier"/,
        '<Property Name="PurchaseOrderId" Type="Edm.Int64" Nullable="false"/><Property Name="Supplier"',
      ],
    ]);
    await assert.rejects(restart(), /PurchaseOrderSet's rows are told apart/);
  });
});

describe("adapting saved rows", () => {
  it("keeps fields that weren't properties, and drops a set the metadata no longer has", async () => {
    const app = createApp({ modelDir: PO_MODEL, v4Path: "/v4", log: () => {} });
    const shape = shapeOf(app.model);
    const was = structuredClone(shape);
    // As if Remarks had been a property when the state was saved, and OldSet a set
    was.sets.PurchaseOrderSet.properties.Remarks = "Edm.String";
    was.sets.OldSet = { identity: ["Id"], properties: {} };
    const [first] = app.store.rows("PurchaseOrderSet");
    const db = new MemoryPersistence();
    await db.replace(
      [
        {
          set: "PurchaseOrderSet",
          written: [
            {
              key: "k",
              row: { ...first, Remarks: "x", $draftUUID: "u", Dynamic: 1 },
            },
          ],
          deleted: [],
        },
        { set: "OldSet", written: [{ key: "o", row: { Id: 1 } }], deleted: [] },
      ],
      was,
    );
    const logs: string[] = [];
    await open(db, app.store, (m) => logs.push(m));
    const [row] = app.store.rows("PurchaseOrderSet");
    assert.equal("Remarks" in row, false);
    assert.equal(row.$draftUUID, "u");
    assert.equal(row.Dynamic, 1);
    assert.equal(app.store.sets().OldSet, undefined);
    assert.ok(
      logs.includes("  OldSet: no longer in the metadata, 1 row dropped"),
    );
    assert.deepEqual(db.shape, shape);
    assert.equal(db.state().OldSet, undefined);
  });

  it("keeps the rows of a set its saved shape doesn't describe as they are", async () => {
    const app = createApp({ modelDir: PO_MODEL, v4Path: "/v4", log: () => {} });
    const was = structuredClone(shapeOf(app.model));
    delete was.sets.PurchaseOrderItemSet;
    was.sets.PurchaseOrderSet.properties.Remarks = "Edm.String"; // a change, to adapt
    const [item] = app.store.rows("PurchaseOrderItemSet");
    const db = new MemoryPersistence();
    await db.replace(
      [
        {
          set: "PurchaseOrderItemSet",
          written: [{ key: "i", row: { ...item, Description: "Kept" } }],
          deleted: [],
        },
      ],
      was,
    );
    await open(db, app.store);
    assert.deepEqual(app.store.rows("PurchaseOrderItemSet"), [
      { ...item, Description: "Kept" },
    ]);
  });

  it("a state saved without a shape is taken as the current one", async () => {
    const app = createApp({ modelDir: PO_MODEL, v4Path: "/v4", log: () => {} });
    const [first] = app.store.rows("PurchaseOrderSet");
    const db = new MemoryPersistence();
    await db.commit([
      {
        set: "PurchaseOrderSet",
        written: [{ key: "k", row: { ...first, Status: "Shapeless" } }],
        deleted: [],
      },
    ]);
    await open(db, app.store);
    assert.deepEqual(
      app.store.rows("PurchaseOrderSet").map((r) => r.Status),
      ["Shapeless"],
    );
  });
});
