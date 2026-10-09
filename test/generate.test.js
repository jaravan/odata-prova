const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../lib/app");
const { writeMockData } = require("../mock-data");
const { start, get, PO_MODEL } = require("./helpers");

const FIXTURES = path.join(__dirname, "fixtures");
const NORTHWIND_V4 = path.join(FIXTURES, "real", "NorthwindV4");

function load(modelDir, mockRows) {
  return createApp({
    modelDir,
    v2Path: "/v2",
    v4Path: "/v4",
    log: () => {},
    mockRows,
  });
}

// A copy of a model in a temporary folder, with only the given seed files
function modelCopy(from, seedFiles = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-"));
  fs.copyFileSync(
    path.join(from, "metadata.xml"),
    path.join(dir, "metadata.xml"),
  );
  if (seedFiles.length) fs.mkdirSync(path.join(dir, "data"));
  for (const f of seedFiles)
    fs.copyFileSync(path.join(from, "data", f), path.join(dir, "data", f));
  return dir;
}

describe("mock data", () => {
  it("is off unless asked for", () => {
    const { store } = load(path.join(FIXTURES, "cap"));
    assert.deepEqual(store.rows("PurchaseOrderSet"), []);
    assert.deepEqual(store.generated, []);
  });

  it("fills every entity set without a seed file, and leaves seeded ones alone", () => {
    const { store } = load(path.join(FIXTURES, "real", "TripPin"), 5);
    assert.equal(store.rows("People").length, 1); // People.json
    for (const set of ["Photos", "Airlines", "Airports"])
      assert.equal(store.rows(set).length, 5, set);
    assert.deepEqual(store.generated, ["Photos", "Airlines", "Airports"]);
  });

  it("is the same on every start", () => {
    assert.deepEqual(
      load(NORTHWIND_V4, 10).store.data,
      load(NORTHWIND_V4, 10).store.data,
    );
  });

  it("respects MaxLength, Scale and Precision, and gives every row a unique key", () => {
    for (const dir of [
      "real/NorthwindV2",
      "real/NorthwindV4",
      "real/TripPin",
      "cap",
    ]) {
      const { model, store } = load(path.join(FIXTURES, dir), 30);
      for (const set of store.generated) {
        const type = model.entityTypes[model.entitySets[set].entityType];
        const keys = store
          .rows(set)
          .map((row) => JSON.stringify(type.keys.map((k) => row[k])));
        assert.equal(
          new Set(keys).size,
          keys.length,
          `${dir} ${set}: duplicate keys`,
        );
        for (const row of store.rows(set)) {
          for (const p of Object.values(type.properties)) {
            const v = row[p.name];
            if (p.maxLength > 0 && typeof v === "string")
              assert.ok(
                v.length <= p.maxLength,
                `${dir} ${set}.${p.name}: '${v}' over MaxLength ${p.maxLength}`,
              );
            if (p.type === "Edm.Decimal" && /^\d+$/.test(p.scale) && v !== null)
              assert.match(
                v,
                new RegExp(
                  `^-?\\d+${p.scale > 0 ? `\\.\\d{${p.scale}}` : ""}$`,
                ),
                `${dir} ${set}.${p.name}`,
              );
            if (
              p.type === "Edm.Decimal" &&
              /^\d+$/.test(p.precision) &&
              v !== null
            )
              assert.ok(
                v.replace(/\D/g, "").replace(/^0+(?=\d)/, "").length <=
                  p.precision,
                `${dir} ${set}.${p.name}: ${v}`,
              );
          }
        }
      }
    }
  });

  it("picks values that fit the property's name", () => {
    const { store } = load(path.join(FIXTURES, "cap"), 5);
    for (const row of store.rows("PurchaseOrderSet")) {
      assert.match(row.Currency, /^[A-Z]{3}$/);
      assert.match(row.OrderDate, /^2025-\d{2}-\d{2}$/);
    }
  });
});

describe("mock data: foreign keys point at real rows", () => {
  let s;
  before(async () => {
    s = await start(NORTHWIND_V4, { mockRows: 10 });
  });
  after(() => s.close());

  it("to a single parent ($expand in V4 and V2)", async () => {
    const v4 = (await get(`${s.v4}/Products?$expand=Category,Supplier`)).body
      .value;
    assert.equal(v4.length, 10);
    for (const p of v4) {
      assert.equal(p.Category?.CategoryID, p.CategoryID);
      assert.equal(p.Supplier?.SupplierID, p.SupplierID);
    }
    const v2 = (await get(`${s.v2}/Products?$expand=Category`)).body.d.results;
    for (const p of v2) assert.equal(p.Category?.CategoryID, p.CategoryID);
  });

  it("to children, which add up to all the rows of the child set", async () => {
    const orders = (await get(`${s.v4}/Orders?$expand=Order_Details`)).body
      .value;
    const items = orders.flatMap((o) => o.Order_Details);
    assert.equal(items.length, s.store.rows("Order_Details").length);
    for (const o of orders)
      for (const item of o.Order_Details) assert.equal(item.OrderID, o.OrderID);
  });
});

describe("mock data: children of seeded parents", () => {
  let s;
  const dir = modelCopy(PO_MODEL, ["PurchaseOrderSet.csv"]);
  before(async () => {
    s = await start(dir, { mockRows: 30 });
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true });
  });

  it("belong to the seeded rows, numbered per parent", () => {
    const orders = new Set(
      s.store.rows("PurchaseOrderSet").map((o) => o.PurchaseOrderId),
    );
    const items = s.store.rows("PurchaseOrderItemSet");
    assert.equal(items.length, 30);
    const positions = {};
    for (const item of items) {
      assert.ok(orders.has(item.PurchaseOrderId), item.PurchaseOrderId);
      (positions[item.PurchaseOrderId] ||= []).push(Number(item.ItemPosition));
    }
    for (const list of Object.values(positions))
      assert.deepEqual(
        list,
        list.map((_, i) => i + 1),
      );
  });
});

describe("mock-data.js", () => {
  for (const [label, from, seeds] of [
    ["CSV", PO_MODEL, ["PurchaseOrderSet.csv"]],
    [
      "JSON, for complex values",
      path.join(FIXTURES, "real", "TripPin"),
      ["People.json"],
    ],
  ]) {
    it(`writes files (${label}) that load back as the same data`, () => {
      const dir = modelCopy(from, seeds);
      try {
        const written = writeMockData(dir, 8);
        assert.ok(written.length > 0);
        const expected = load(dir, 8).store.data;
        const reloaded = load(dir, 0).store;
        assert.deepEqual(reloaded.generated, []);
        assert.deepEqual(reloaded.data, expected);
      } finally {
        fs.rmSync(dir, { recursive: true });
      }
    });
  }

  it("never overwrites a data file, and writes nothing when every set has one", () => {
    const dir = modelCopy(PO_MODEL, [
      "PurchaseOrderSet.csv",
      "PurchaseOrderItemSet.csv",
    ]);
    try {
      const before = fs.readFileSync(
        path.join(dir, "data", "PurchaseOrderSet.csv"),
        "utf8",
      );
      assert.deepEqual(writeMockData(dir, 5), []);
      assert.equal(
        fs.readFileSync(path.join(dir, "data", "PurchaseOrderSet.csv"), "utf8"),
        before,
      );
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
