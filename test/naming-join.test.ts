import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseMetadata } from "../lib/metadata.ts";
import { start, get, send, type TestServer } from "./helpers.ts";

// Order and Item both keyed by ID, and no ReferentialConstraint: the join comes from naming.
// Items 1, 2, 3 belong to orders 1, 1, 2 (Item.OrderID). Matching the source's key names alone
// would join Order.ID to Item.ID; the convention <Source>ID finds the real foreign key.
for (const version of ["V2", "V4"]) {
  describe(`join by naming, both types keyed by ID (${version} metadata)`, () => {
    let s: TestServer;
    before(
      async () =>
        (s = await start(
          path.join(import.meta.dirname, "fixtures", `NamingJoin${version}`),
        )),
    );
    after(() => s.close());

    it("joins on the foreign key named after the other side, both ways, and logs it", () => {
      const nav = (type: string, name: string) =>
        s.model.entityTypes[`S.${type}`].navigations[name];
      assert.deepEqual(nav("Order", "Items").join, [["ID", "OrderID"]]);
      assert.deepEqual(nav("Item", "Order").join, [["OrderID", "ID"]]);
      assert.equal(nav("Order", "Items").partner, "Order");
      assert.equal(nav("Order", "Items").cascadeDelete, false);
      assert.deepEqual(s.model.warnings, [
        "navigation joined by naming: Order.Items on Order.ID = Item.OrderID (no ReferentialConstraint)",
        "navigation joined by naming: Item.Order on Item.OrderID = Order.ID (no ReferentialConstraint)",
      ]);
    });

    it("an order's items are the ones that point at it", async () => {
      const items = async (order: number) =>
        (await get(`${s.v4}/Orders(${order})/Items?$select=ID`)).body.value.map(
          (i: { ID: number }) => i.ID,
        );
      assert.deepEqual(await items(1), [1, 2]);
      assert.deepEqual(await items(2), [3]);
      assert.equal((await get(`${s.v4}/Items(3)/Order`)).body.ID, 2);
    });

    it("deleting an order deletes neither its items nor anything else", async () => {
      assert.equal((await send("DELETE", `${s.v4}/Orders(2)`)).status, 204);
      assert.equal((await get(`${s.v4}/Items`)).body.value.length, 3);
    });
  });
}

// JOINS=strict: no guessing. The same models' navigations are disabled instead, with the reason.
for (const version of ["V2", "V4"]) {
  describe(`strict joins: a navigation without a ReferentialConstraint is disabled (${version} metadata)`, () => {
    let s: TestServer;
    before(
      async () =>
        (s = await start(
          path.join(import.meta.dirname, "fixtures", `NamingJoin${version}`),
          { joins: "strict" },
        )),
    );
    after(() => s.close());

    it("guesses no join, and logs each navigation it disables", () => {
      const order = s.model.entityTypes["S.Order"];
      assert.equal(order.navigations.Items, undefined);
      assert.match(order.disabledNavigations!.Items, /joins are strict/);
      assert.equal(s.model.entityTypes["S.Item"].navigations.Order, undefined);
      assert.equal(s.model.warnings.length, 2);
      for (const w of s.model.warnings)
        assert.match(
          w,
          /^navigation disabled: (Order\.Items|Item\.Order): no ReferentialConstraint for .*, and joins are strict \(not guessed\) - add one to metadata\.xml$/,
        );
    });

    it("a request through the navigation is a 501 saying why; the entities still work", async () => {
      for (const url of [
        `${s.v4}/Orders(1)/Items`,
        `${s.v4}/Orders?$expand=Items`,
      ]) {
        const r = await get(url);
        assert.equal(r.status, 501);
        assert.match(r.body.error.message, /add one to metadata\.xml/);
      }
      assert.equal((await get(`${s.v4}/Items`)).body.value.length, 3);
    });
  });
}

describe("strict joins leave a declared join as it is", () => {
  // V2 association constraints, and V4 constraints on one side only (as CAP writes them),
  // which the other side takes from its partner: neither is a guess
  for (const name of ["PurchaseOrderSrv", "DraftSrv"])
    it(`${name}: the same navigations, none disabled`, () => {
      const xml = fs.readFileSync(
        path.join(import.meta.dirname, "fixtures", name, "metadata.xml"),
        "utf8",
      );
      const strict = parseMetadata(xml, { joins: "strict" });
      const guess = parseMetadata(xml);
      assert.deepEqual(
        strict.warnings.filter((w) => w.startsWith("navigation")),
        [],
      );
      // Not a comparison of nothing with nothing
      assert.ok(
        Object.values(guess.entityTypes).some(
          (t) => Object.keys(t.navigations).length,
        ),
      );
      for (const [typeName, type] of Object.entries(guess.entityTypes)) {
        assert.deepEqual(
          strict.entityTypes[typeName].navigations,
          type.navigations,
        );
      }
    });
});

describe("JOINS", () => {
  it("the server refuses to start with an unknown mode", async () => {
    const child = spawn(
      process.execPath,
      [
        path.join(import.meta.dirname, "..", "server.ts"),
        path.join(import.meta.dirname, "fixtures", "NamingJoinV4"),
      ],
      { env: { ...process.env, PORT: "0", JOINS: "guessing" } },
    );
    let output = "";
    child.stderr.on("data", (d) => (output += d));
    const code = await new Promise<number | null>((resolve) =>
      child.on("exit", resolve),
    );
    assert.equal(code, 1);
    assert.match(output, /JOINS must be one of guess, strict, got 'guessing'/);
  });
});
