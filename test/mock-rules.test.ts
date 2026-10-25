import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMetadata } from "../lib/metadata.ts";
import { parseMockKey, parseMockValue, type MockRule } from "../lib/config.ts";
import { resolveMockRules } from "../lib/mock-rules.ts";
import { createApp } from "../lib/app.ts";
import { PO_MODEL } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const model = (dir: string) =>
  parseMetadata(fs.readFileSync(path.join(dir, "metadata.xml"), "utf8"));
const PO = model(PO_MODEL);

// A rule as config.ts reads it: from the model's own file, or a shared one
function rule(key: string, value: unknown, shared = false): MockRule {
  return {
    key,
    ...parseMockKey(key),
    value: parseMockValue(value as never, key),
    file: shared ? "shared.json" : "config.json",
    shared,
  };
}
// The rule each set's property follows, by key, for comparing
const keys = (resolved: ReturnType<typeof resolveMockRules>) =>
  Object.fromEntries(
    Object.entries(resolved).map(([set, props]) => [
      set,
      Object.fromEntries(Object.entries(props).map(([p, r]) => [p, r.key])),
    ]),
  );
// The mistakes listed, one per line after the header
const mistakes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.equal((e as { code?: string }).code, "ECONFIG");
    return (e as Error).message
      .split("\n")
      .slice(1)
      .map((l) => l.trim());
  }
  assert.fail("no error");
};

describe("mock rules: what they apply to", () => {
  it("a Set.Property rule to that set, a Property rule to every set that has it, the first winning", () => {
    assert.deepEqual(
      keys(
        resolveMockRules(PO, [
          rule("Currency", "EUR"),
          rule("purchaseorderset.currency", "USD"),
          rule("PurchaseOrderSet.PurchaseOrderId", "45########"),
        ]),
      ),
      {
        // the real names, whatever the case written
        PurchaseOrderSet: {
          Currency: "purchaseorderset.currency",
          PurchaseOrderId: "PurchaseOrderSet.PurchaseOrderId",
        },
        PurchaseOrderItemSet: { Currency: "Currency" },
      },
    );
  });

  it("a complex property's member", () => {
    const gateway = model(path.join(FIXTURES, "GatewaySrv"));
    assert.deepEqual(
      keys(resolveMockRules(gateway, [rule("Address/City", ["Walldorf"])])),
      { BusinessPartnerSet: { "Address/City": "Address/City" } },
    );
  });

  it("not a foreign key, whose value comes from the row it points at, for a Property rule", () => {
    assert.deepEqual(
      keys(resolveMockRules(PO, [rule("PurchaseOrderId", "45########")])),
      { PurchaseOrderSet: { PurchaseOrderId: "PurchaseOrderId" } },
    );
  });

  it("from a shared file, whatever it names that the model doesn't have, skipped", () => {
    assert.deepEqual(
      keys(
        resolveMockRules(PO, [
          rule("SalesOrderSet.Status", "Open", true),
          rule("Plant", "1000", true),
          rule("PurchaseOrderSet.Currency", "EURO", true),
          rule("Status", ["Open"], true),
        ]),
      ),
      {
        PurchaseOrderSet: { Status: "Status" },
      },
    );
  });
});

describe("mock rules: mistakes, and how to fix them", () => {
  it("lists each, with the closest name or the right shape", () => {
    assert.deepEqual(
      mistakes(() =>
        resolveMockRules(PO, [
          rule("PurchaseOrderSet.Staus", ["Open"]),
          rule("PurchaseOrderStet.Status", "Open"),
          rule("Plnt", "1000"),
          rule("PurchaseOrderSet.PurchaseOrderId", "EUR"),
          rule("PurchaseOrderSet.PurchaseOrderId2", "1"),
          rule("PurchaseOrderItemSet.PurchaseOrderId", "45########"),
          rule("PurchaseOrderSet.Currency", "EURO"),
          rule("PurchaseOrderSet.Status", "############################"),
          rule("PurchaseOrderSet.TotalAmount", "lots"),
          rule("PurchaseOrderSet.OrderDate", "1..5"),
          rule("PurchaseOrderSet.Status/Code", "A"),
        ]),
      ),
      [
        'mock "PurchaseOrderSet.Staus": PurchaseOrderSet has no property Staus. Did you mean "Status"?',
        'mock "PurchaseOrderStet.Status": no such entity set. Did you mean "PurchaseOrderSet"?',
        'mock "Plnt": no entity set has a property Plnt.',
        'mock "PurchaseOrderSet.PurchaseOrderId": a key needs a running number, so every row\'s is different: e.g. "##########"',
        'mock "PurchaseOrderSet.PurchaseOrderId2": PurchaseOrderSet has no property PurchaseOrderId2. Did you mean "PurchaseOrderId"?',
        'mock "PurchaseOrderItemSet.PurchaseOrderId": PurchaseOrderId is a foreign key: its value comes from the row it points at, so a rule can\'t set it',
        'mock "PurchaseOrderSet.Currency": "EURO" is 4 long, MaxLength is 3',
        'mock "PurchaseOrderSet.Status": "############################" is 28 long, MaxLength is 20',
        'mock "PurchaseOrderSet.TotalAmount": "lots" doesn\'t fit TotalAmount (Edm.Decimal)',
        'mock "PurchaseOrderSet.OrderDate": "1..5" is a range of numbers, OrderDate is Edm.Date',
        'mock "PurchaseOrderSet.Status/Code": Status isn\'t a complex property, it has no members',
      ],
    );
  });

  it("a running number too big for an Int32 key", () => {
    const northwind = model(path.join(FIXTURES, "real", "NorthwindV4"));
    assert.deepEqual(
      mistakes(() =>
        resolveMockRules(northwind, [rule("Orders.OrderID", "45########")]),
      ),
      [
        'mock "Orders.OrderID": "45########" can\'t fit Edm.Int32 (at most 2147483647)',
      ],
    );
  });

  it("a Property rule that fits none of the sets that have it, why for each", () => {
    assert.deepEqual(
      mistakes(() => resolveMockRules(PO, [rule("Currency", "EURO")])),
      [
        'mock "Currency": PurchaseOrderSet: "EURO" is 4 long, MaxLength is 3; PurchaseOrderItemSet: "EURO" is 4 long, MaxLength is 3',
      ],
    );
  });

  it("stop the start, naming config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rules-"));
    fs.copyFileSync(
      path.join(PO_MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ mock: { "PurchaseOrderSet.Staus": "Open" } }),
    );
    assert.throws(
      () => createApp({ modelDir: dir, v4Path: "/v4", log: () => {} }),
      (e: Error & { code?: string }) =>
        e.code === "ECONFIG" &&
        e.message.startsWith(
          `${path.join(dir, "config.json")}: a mock rule that doesn't fit the model:`,
        ),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
