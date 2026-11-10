import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, type TestServer } from "./helpers.ts";

const EDM_TYPES = path.join(import.meta.dirname, "fixtures", "EdmTypes");

// round, floor and ceiling give what they're given: URL Conventions 5.1.1.9 has them as
// Edm.Decimal round(Edm.Decimal) and Edm.Double round(Edm.Double)
describe("round, floor and ceiling keep their argument's type", () => {
  let s: TestServer;
  before(async () => {
    s = await start(EDM_TYPES);
  });
  after(() => s.close());

  const q = encodeURIComponent;
  // As the response writes it: JSON.parse would round a long number
  const computed = async (expression: string) => {
    const r = await fetch(
      `${s.v4}/Values?$compute=${q(`${expression} as K`)}&$select=K`,
    );
    assert.equal(r.status, 200);
    return /"K":([^,}]*)/.exec(await r.text())![1];
  };
  const finds = async (base: string, filter: string) => {
    const r = await get(`${base}/Values?$filter=${q(filter)}`);
    assert.equal(r.status, 200);
    return (r.body.value ?? r.body.d.results).length === 1;
  };

  const decimals: [string, string][] = [
    ["round(1.5)", "2"],
    ["round(2.5)", "3"],
    ["round(-2.5)", "-3"],
    ["round(1.4)", "1"],
    ["round(-1.4)", "-1"],
    ["round(-0.4)", "0"],
    ["round(0.49999999999999999999)", "0"],
    ["floor(1.9)", "1"],
    ["floor(-1.1)", "-2"],
    ["floor(-0.1)", "-1"],
    ["floor(2.0)", "2"],
    ["ceiling(1.1)", "2"],
    ["ceiling(-1.9)", "-1"],
    ["ceiling(0.1)", "1"],
    ["ceiling(2.0)", "2"],
  ];
  for (const [expression, value] of decimals)
    it(`${expression} is ${value}`, async () => {
      assert.equal(await computed(expression), value);
    });

  it("a decimal keeps every digit", async () => {
    assert.equal(await computed("round(Amount)"), "12345678901234567890");
    assert.equal(await computed("floor(Amount)"), "12345678901234567890");
    assert.equal(await computed("ceiling(Amount)"), "12345678901234567891");
    assert.equal(
      await computed("-floor(Amount) sub 1"),
      "-12345678901234567891",
    );
  });

  it("its result is a decimal, so div doesn't round towards zero", async () => {
    assert.equal(await computed("floor(1.9) div 2"), "0.5");
    assert.equal(await computed("round(1.4) divby 4"), "0.25");
    assert.equal(await computed("ceiling(Price) div 4"), "0.5");
  });

  it("a double stays a double", async () => {
    assert.equal(await computed("floor(1.5e0) div 2"), "0.5");
    assert.equal(await computed("round(2.5e0)"), "3");
    assert.equal(await computed("round(-2.5e0)"), "-3");
    assert.equal(await computed("ceiling(1.5e0) div 4"), "0.5");
  });

  it("an integer is unchanged, and div of it still rounds towards zero", async () => {
    assert.equal(await computed("round(5)"), "5");
    assert.equal(await computed("floor(5) div 2"), "2");
    assert.equal(await computed("ceiling(Big)"), "9007199254740993");
  });

  it("in a $filter, V4's and V2's", async () => {
    assert.equal(
      await finds(s.v4, "round(Amount) eq 12345678901234567890"),
      true,
    );
    assert.equal(
      await finds(s.v4, "round(Amount) eq 12345678901234567891"),
      false,
    );
    assert.equal(await finds(s.v4, "floor(Price) div 2 eq 0.5"), true);
    assert.equal(await finds(s.v2, "ceiling(Price) eq 2"), true);
    assert.equal(
      await finds(s.v2, "ceiling(Amount) eq 12345678901234567891m"),
      true,
    );
  });
});
