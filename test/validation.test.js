const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  start,
  get,
  send,
  SALES_MODEL,
  PO_MODEL,
  ORDER: PO,
  ITEM,
} = require("./helpers");
const { createApp } = require("../lib/app");

// A copy of a model folder with its metadata.xml edited, removed again by the returned cleanup
function editedModel(modelDir, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-"));
  fs.cpSync(modelDir, dir, { recursive: true });
  const file = path.join(dir, "metadata.xml");
  fs.writeFileSync(file, edit(fs.readFileSync(file, "utf8")));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const ORDER = "Orders(11111111-1111-1111-1111-111111111111)";

// A value that doesn't fit its property's type is a 400, not a 500 and not stored as is
describe("values are checked against their Edm type", () => {
  let s;
  before(async () => {
    s = await start(SALES_MODEL);
  });
  after(() => s.close());

  it("an invalid date -> 400 on both protocols", async () => {
    const v4 = await send("POST", `${s.v4}/Orders`, {
      ID: "33333333-3333-3333-3333-333333333333",
      OrderDate: "notadate",
    });
    assert.equal(v4.status, 400);
    assert.match(v4.body.error.message, /Invalid Edm.Date value: notadate/);

    const v2 = await send("POST", `${s.v2}/Orders`, {
      ID: "33333333-3333-3333-3333-333333333333",
      CreatedAt: "notadate",
    });
    assert.equal(v2.status, 400);
    assert.match(
      v2.body.error.message.value,
      /Invalid Edm.DateTimeOffset value/
    );
  });

  it("an invalid number or boolean -> 400, and the entity keeps its value", async () => {
    for (const [prop, value] of [
      ["Total", "abc"],
      ["Qty", "abc"],
      ["Qty", 1.5],
      ["Closed", "maybe"],
    ]) {
      const r = await send("PATCH", `${s.v4}/${ORDER}`, { [prop]: value });
      assert.equal(r.status, 400, `${prop}: ${value}`);
    }
    const r = await get(`${s.v4}/${ORDER}?$select=Total,Qty,Closed`, {
      accept: "application/json;IEEE754Compatible=true",
    });
    assert.deepEqual(
      [r.body.Total, r.body.Qty, r.body.Closed],
      ["100.50", 3, false]
    );
  });

  it("one invalid value -> 400, and the valid ones in the same request aren't written", async () => {
    const r = await send("PATCH", `${s.v4}/${ORDER}`, {
      Total: "5.00",
      Qty: "abc",
    });
    assert.equal(r.status, 400);
    const after = await get(`${s.v4}/${ORDER}?$select=Total,Qty`, {
      accept: "application/json;IEEE754Compatible=true",
    });
    assert.deepEqual([after.body.Total, after.body.Qty], ["100.50", 3]);
  });

  it("accepts what the types allow: TRUE, numbers as strings, exponents", async () => {
    const r = await send("PATCH", `${s.v4}/${ORDER}`, {
      Closed: "TRUE",
      Qty: "7",
      Total: "-1.5e2",
    });
    assert.equal(r.status, 204);
    const after = await get(`${s.v4}/${ORDER}?$select=Total,Qty,Closed`, {
      accept: "application/json;IEEE754Compatible=true",
    });
    assert.deepEqual(
      [after.body.Total, after.body.Qty, after.body.Closed],
      ["-1.5e2", 7, true]
    );
  });
});

// Every non-key property of PO_MODEL's order and item is Nullable="false"
describe('Nullable="false" properties are required', () => {
  let s;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("a create without one -> 400 on both protocols, and nothing is stored", async () => {
    const { Supplier, ...noSupplier } = PO;
    const v4 = await send("POST", `${s.v4}/PurchaseOrderSet`, {
      ...noSupplier,
      PurchaseOrderId: "N001",
    });
    assert.equal(v4.status, 400);
    assert.equal(v4.body.error.message, "Property Supplier is required");
    const v2 = await send("POST", `${s.v2}/PurchaseOrderSet`, {
      ...PO,
      PurchaseOrderId: "N001",
      Currency: null,
    });
    assert.equal(v2.status, 400);
    assert.equal(v2.body.error.message.value, "Property Currency is required");
    assert.equal((await get(`${s.v4}/PurchaseOrderSet('N001')`)).status, 404);
  });

  it("a deep insert whose related entity lacks one -> 400, and the parent is rolled back", async () => {
    const r = await send("POST", `${s.v4}/PurchaseOrderSet`, {
      ...PO,
      PurchaseOrderId: "N002",
      Items: [{ ...ITEM, ItemPosition: "0001", Material: null }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.message, "Property Material is required");
    assert.equal((await get(`${s.v4}/PurchaseOrderSet('N002')`)).status, 404);
  });

  it("an update that sets one to null -> 400, and the entity keeps its value", async () => {
    const order = `${s.v4}/PurchaseOrderSet('4500000001')`;
    const patch = await send("PATCH", order, {
      Status: "Approved",
      Supplier: null,
    });
    assert.equal(patch.status, 400);
    assert.equal(patch.body.error.message, "Property Supplier is required");
    const put = await send("PUT", order, { Supplier: "Only this" });
    assert.equal(put.status, 400);
    const after = await get(`${order}?$select=Supplier,Status`);
    assert.deepEqual(
      [after.body.Supplier, after.body.Status],
      ["Acme Components Ltd", "Open"]
    );
    // A PATCH needs only the values it changes
    assert.equal((await send("PATCH", order, { Status: "Open" })).status, 204);
  });

  it("not when the client may not set it (sap:creatable, sap:updatable) or the entity is a draft", async () => {
    const po = editedModel(PO_MODEL, (xml) =>
      xml.replace(
        'Name="Status" Type="Edm.String" Nullable="false"',
        '$& sap:creatable="false" sap:updatable="false"'
      )
    );
    const drafts = editedModel(
      path.join(__dirname, "fixtures", "DraftSrv"),
      (xml) =>
        xml.replaceAll('Name="title" Type="Edm.String"', '$& Nullable="false"')
    );
    const s1 = await start(po.dir),
      s2 = await start(drafts.dir);
    try {
      const { Status, ...noStatus } = PO;
      assert.equal(
        (
          await send("POST", `${s1.v4}/PurchaseOrderSet`, {
            ...noStatus,
            PurchaseOrderId: "N003",
          })
        ).status,
        201
      );
      assert.equal(
        (await send("PUT", `${s1.v4}/PurchaseOrderSet('N003')`, noStatus))
          .status,
        204
      );

      const draft = await send("POST", `${s2.v4}/Books`, {});
      assert.equal(draft.status, 201);
      assert.equal(draft.body.title, null);
      const url = `${s2.v4}/Books(ID=${draft.body.ID},IsActiveEntity=false)`;
      assert.equal((await send("PATCH", url, { title: null })).status, 204);
    } finally {
      await s1.close();
      await s2.close();
      po.cleanup();
      drafts.cleanup();
    }
  });
});

describe("a seed file with an invalid value", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
    fs.copyFileSync(
      path.join(SALES_MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml")
    );
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(
      path.join(dir, "data", "Orders.csv"),
      "ID;Total\n11111111-1111-1111-1111-111111111111;10.00\n22222222-2222-2222-2222-222222222222;12,50\n"
    );
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("fails at startup, naming the file and the row", () => {
    assert.throws(
      () => createApp({ modelDir: dir, v4Path: "/v4", log: () => {} }),
      (err) =>
        err.code === "ESEED" &&
        /Orders\.csv: row 3: Invalid Edm.Decimal value: 12,50/.test(err.message)
    );
  });
});
