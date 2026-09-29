const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { start, get, send, SALES_MODEL } = require("./helpers");
const { createApp } = require("../lib/app");

const ORDER = "Orders(11111111-1111-1111-1111-111111111111)";

// A value that doesn't fit its property's type is a 400, not a 500 and not stored as is
describe("values are checked against their Edm type", () => {
  let s;
  before(async () => { s = await start(SALES_MODEL); });
  after(() => s.close());

  it("an invalid date -> 400 on both protocols", async () => {
    const v4 = await send("POST", `${s.v4}/Orders`, { ID: "33333333-3333-3333-3333-333333333333", OrderDate: "notadate" });
    assert.equal(v4.status, 400);
    assert.match(v4.body.error.message, /Invalid Edm.Date value: notadate/);

    const v2 = await send("POST", `${s.v2}/Orders`, { ID: "33333333-3333-3333-3333-333333333333", CreatedAt: "notadate" });
    assert.equal(v2.status, 400);
    assert.match(v2.body.error.message.value, /Invalid Edm.DateTimeOffset value/);
  });

  it("an invalid number or boolean -> 400, and the entity keeps its value", async () => {
    for (const [prop, value] of [["Total", "abc"], ["Qty", "abc"], ["Qty", 1.5], ["Closed", "maybe"]]) {
      const r = await send("PATCH", `${s.v4}/${ORDER}`, { [prop]: value });
      assert.equal(r.status, 400, `${prop}: ${value}`);
    }
    const r = await get(`${s.v4}/${ORDER}?$select=Total,Qty,Closed`, { accept: "application/json;IEEE754Compatible=true" });
    assert.deepEqual([r.body.Total, r.body.Qty, r.body.Closed], ["100.50", 3, false]);
  });

  it("one invalid value -> 400, and the valid ones in the same request aren't written", async () => {
    const r = await send("PATCH", `${s.v4}/${ORDER}`, { Total: "5.00", Qty: "abc" });
    assert.equal(r.status, 400);
    const after = await get(`${s.v4}/${ORDER}?$select=Total,Qty`, { accept: "application/json;IEEE754Compatible=true" });
    assert.deepEqual([after.body.Total, after.body.Qty], ["100.50", 3]);
  });

  it("accepts what the types allow: TRUE, numbers as strings, exponents", async () => {
    const r = await send("PATCH", `${s.v4}/${ORDER}`, { Closed: "TRUE", Qty: "7", Total: "-1.5e2" });
    assert.equal(r.status, 204);
    const after = await get(`${s.v4}/${ORDER}?$select=Total,Qty,Closed`, { accept: "application/json;IEEE754Compatible=true" });
    assert.deepEqual([after.body.Total, after.body.Qty, after.body.Closed], ["-1.5e2", 7, true]);
  });
});

describe("a seed file with an invalid value", () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
    fs.copyFileSync(path.join(SALES_MODEL, "metadata.xml"), path.join(dir, "metadata.xml"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(
      path.join(dir, "data", "Orders.csv"),
      "ID;Total\n11111111-1111-1111-1111-111111111111;10.00\n22222222-2222-2222-2222-222222222222;12,50\n",
    );
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("fails at startup, naming the file and the row", () => {
    assert.throws(
      () => createApp({ modelDir: dir, v4Path: "/v4", log: () => {} }),
      (err) => err.code === "ESEED" && /Orders\.csv: row 3: Invalid Edm.Decimal value: 12,50/.test(err.message),
    );
  });
});
