// A number too long for a decimal (see DECIMAL_DIGITS) still compares as the number it is
// with the decimals a set holds: both are counted in the same units.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start, type TestServer } from "./helpers.ts";

const SPELLINGS = path.join(import.meta.dirname, "fixtures", "Spellings");
const HUGE = `1${"0".repeat(42)}`;
const ALL = [1, 2, 3, 4, 6];

describe("a Decimal against a number longer than a decimal can be", () => {
  let s: TestServer;
  before(async () => {
    s = await start(SPELLINGS);
    await send("POST", `${s.v4}/Rows`, { ID: 6, Amount: "10000000000" });
  });
  after(() => s.close());

  const ids = async (expression: string, root = s.v4) => {
    const { status, body } = await get(
      `${root}/Rows?$filter=${encodeURIComponent(expression)}&$select=ID`,
    );
    assert.equal(status, 200, expression);
    return (root === s.v2 ? body.d.results : body.value).map(
      (r: { ID: number }) => r.ID,
    );
  };

  for (const [expression, expected] of [
    [`Amount gt ${HUGE}`, []],
    [`Amount ge ${HUGE}`, []],
    [`Amount lt ${HUGE}`, ALL],
    [`Amount le ${HUGE}`, ALL],
    [`Amount eq ${HUGE}`, []],
    [`Amount ne ${HUGE}`, [1, 2, 3, 4, 5, 6]],
    [`Amount gt -${HUGE}`, ALL],
    [`Amount lt -${HUGE}`, []],
    [`${HUGE} gt Amount`, ALL],
    [`Amount gt '${HUGE}'`, []],
    [`Amount lt '${HUGE}'`, ALL],
    [`Amount lt ${HUGE}.5`, ALL],
    [`Amount lt 0.3000000000000000000000000000000000000000000001`, [1, 2, 3]],
    [`Amount gt 0.3000000000000000000000000000000000000000000001`, [4, 6]],
    [`Amount gt 0.2999999999999999999999999999999999999999999999`, ALL],
    [`Amount lt 0.3`, []],
    [`Amount eq 0.3`, [1, 2, 3]],
  ] as const) {
    it(expression, async () => {
      assert.deepEqual(await ids(expression), expected);
    });
  }

  it("V2, with its suffixes", async () => {
    for (const suffix of ["", "m", "L"]) {
      assert.deepEqual(await ids(`Amount gt ${HUGE}${suffix}`, s.v2), []);
      assert.deepEqual(await ids(`Amount lt ${HUGE}${suffix}`, s.v2), ALL);
    }
  });

  it("text that is no number is a 400, not a crash", async () => {
    for (const filter of ["Amount eq 'x'", "Amount eq ''"]) {
      const url = `${s.v4}/Rows?$filter=${encodeURIComponent(filter)}`;
      assert.equal((await get(url)).status, 400, filter);
    }
  });

  it("an Int64 against one", async () => {
    assert.deepEqual(await ids(`Big lt ${HUGE}`), [1, 2, 3, 4]);
    assert.deepEqual(await ids(`Big gt ${HUGE}`), []);
  });

  it("INF is beyond it", async () => {
    assert.deepEqual(await ids("Amount lt INF"), ALL);
    assert.deepEqual(await ids("Amount gt -INF"), ALL);
  });
});
