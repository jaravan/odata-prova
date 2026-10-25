import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../lib/app.ts";
import { writeMockData } from "../lib/mock-data.ts";
import { start, get, PO_MODEL, type TestServer } from "./helpers.ts";
import type { Row } from "../lib/model.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const NORTHWIND_V4 = path.join(FIXTURES, "real", "NorthwindV4");

function load(modelDir: string, mockRows?: number) {
  return createApp({
    modelDir,
    v2Path: "/v2",
    v4Path: "/v4",
    log: () => {},
    mockRows,
  });
}

// A copy of a model in a temporary folder, with only the given seed files
function modelCopy(from: string, seedFiles: string[] = []) {
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
    // The contained sets of Person.Trips and Trip.PlanItems too
    assert.deepEqual(store.generated, [
      "Photos",
      "Airlines",
      "Airports",
      "People-Trips",
      "People-Trips-PlanItems",
    ]);
  });

  it("is the same on every start", () => {
    assert.deepEqual(
      load(NORTHWIND_V4, 10).store.sets(),
      load(NORTHWIND_V4, 10).store.sets(),
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
          // The facets are strings, as in the XML (MaxLength can be "max")
          for (const p of Object.values(type.properties)) {
            const v = row[p.name];
            if (Number(p.maxLength) > 0 && typeof v === "string")
              assert.ok(
                v.length <= Number(p.maxLength),
                `${dir} ${set}.${p.name}: '${v}' over MaxLength ${p.maxLength}`,
              );
            // A decimal is a string in the store
            if (
              p.type === "Edm.Decimal" &&
              /^\d+$/.test(p.scale ?? "") &&
              v !== null
            )
              assert.match(
                v as string,
                new RegExp(
                  `^-?\\d+${Number(p.scale) > 0 ? `\\.\\d{${p.scale}}` : ""}$`,
                ),
                `${dir} ${set}.${p.name}`,
              );
            if (
              p.type === "Edm.Decimal" &&
              /^\d+$/.test(p.precision ?? "") &&
              v !== null
            )
              assert.ok(
                (v as string).replace(/\D/g, "").replace(/^0+(?=\d)/, "")
                  .length <= Number(p.precision),
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
      assert.match(row.Currency as string, /^[A-Z]{3}$/);
      assert.match(row.OrderDate as string, /^2025-\d{2}-\d{2}$/);
    }
  });

  it("gives a row's place, currency and company code from one location", () => {
    const northwind = load(path.join(FIXTURES, "real", "NorthwindV2"), 40);
    const customers = northwind.store.rows("Customers");
    assert.ok(together(customers, "City", "Country") > 3);
    together(customers, "City", "Region");
    for (const row of customers)
      if (row.Country === "Germany")
        assert.match(row.PostalCode as string, /^\d{5}$/);
      else if (row.Country === "United Kingdom")
        assert.match(
          row.PostalCode as string,
          /^[A-Z]{1,2}\d[A-Z]? \d[A-Z]{2}$/,
        );
    together(northwind.store.rows("Orders"), "ShipCity", "ShipCountry");

    const orders = load(modelCopy(PO_MODEL), 40).store.rows("PurchaseOrderSet");
    assert.ok(together(orders, "CompanyCode", "Currency") > 3);

    // Inside a complex value too
    const partners = load(modelCopy(path.join(FIXTURES, "GatewaySrv")), 40)
      .store.rows("BusinessPartnerSet")
      .map((row) => row.Address as Row);
    together(partners, "City", "Country");
  });

  it("gives a row's product and unit from one product", () => {
    const items = load(modelCopy(PO_MODEL), 40).store.rows(
      "PurchaseOrderItemSet",
    );
    assert.ok(together(items, "Material", "Unit") > 3);
  });

  it("puts a row's dates in order, and later rows later", () => {
    const orders = load(
      path.join(FIXTURES, "real", "NorthwindV2"),
      20,
    ).store.rows("Orders");
    let previous = "";
    for (const o of orders) {
      const ordered = o.OrderDate as string;
      assert.ok(ordered < (o.RequiredDate as string), `order ${o.OrderID}`);
      assert.ok(ordered < (o.ShippedDate as string), `order ${o.OrderID}`);
      assert.ok(
        ordered > previous,
        `order ${o.OrderID} before the one before it`,
      );
      previous = ordered;
    }
  });

  it("counts pieces and measures the rest: a quantity's decimals follow its unit", () => {
    const counted = (unit: unknown) => unit === "PC" || unit === "EA";
    const check = (rows: readonly Row[], quantity: string, unit: string) => {
      const units = new Set(rows.map((r) => r[unit]));
      assert.ok(
        [...units].some(counted) && [...units].some((u) => !counted(u)),
      );
      for (const row of rows)
        if (counted(row[unit]))
          assert.match(
            row[quantity] as string,
            /^\d+\.0+$/,
            `${row[quantity]} ${row[unit]}`,
          );
    };
    // By name: Quantity and Unit
    check(
      load(modelCopy(PO_MODEL), 40).store.rows("PurchaseOrderItemSet"),
      "Quantity",
      "Unit",
    );
    // By the metadata: sap:unit="WeightUnit" on Weight, though neither is named so
    const products = load(
      path.join(FIXTURES, "SapAnnotationsV2"),
      40,
    ).store.rows("Products");
    check(products, "Weight", "WeightUnit");
    for (const row of products)
      assert.match(row.Currency as string, /^[A-Z]{3}$/);
  });
});

// Asserts that each value of column a always comes with the same value of column b, and
// returns how many values of a there are
function together(rows: readonly Row[], a: string, b: string): number {
  const seen = new Map<unknown, unknown>();
  for (const row of rows) {
    if (seen.has(row[a]))
      assert.equal(row[b], seen.get(row[a]), `${a} ${String(row[a])}`);
    seen.set(row[a], row[b]);
  }
  return seen.size;
}

describe("mock data: foreign keys point at real rows", () => {
  let s: TestServer;
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
    const items = orders.flatMap(
      (o: { Order_Details: unknown[] }) => o.Order_Details,
    );
    assert.equal(items.length, s.store.rows("Order_Details").length);
    for (const o of orders)
      for (const item of o.Order_Details) assert.equal(item.OrderID, o.OrderID);
  });
});

describe("mock data: children of seeded parents", () => {
  let s: TestServer;
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
    // Each order's item positions
    const positions: Record<string, number[]> = {};
    for (const item of items) {
      const order = String(item.PurchaseOrderId);
      assert.ok(orders.has(item.PurchaseOrderId), order);
      (positions[order] ||= []).push(Number(item.ItemPosition));
    }
    for (const list of Object.values(positions))
      assert.deepEqual(
        list,
        list.map((_, i) => i + 1),
      );
  });
});

describe("mock-data.js", () => {
  // label, model folder, seed files to copy
  const cases: [string, string, string[]][] = [
    ["CSV", PO_MODEL, ["PurchaseOrderSet.csv"]],
    [
      "JSON, for complex values",
      path.join(FIXTURES, "real", "TripPin"),
      ["People.json"],
    ],
  ];
  for (const [label, from, seeds] of cases) {
    it(`writes files (${label}) that load back as the same data`, () => {
      const dir = modelCopy(from, seeds);
      try {
        const written = writeMockData(dir, 8);
        assert.ok(written.length > 0);
        const expected = load(dir, 8).store.sets();
        const reloaded = load(dir, 0).store;
        assert.deepEqual(reloaded.generated, []);
        assert.deepEqual(reloaded.sets(), expected);
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
