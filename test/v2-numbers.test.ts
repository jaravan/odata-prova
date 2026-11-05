// A number in a V2 URL has the type V4 gives it, unless a suffix says otherwise: 3 is an
// integer, so V2's filters find what V4's do.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start, type TestServer } from "./helpers.ts";

const SPELLINGS = path.join(import.meta.dirname, "fixtures", "Spellings");

describe("an integer in a V2 URL", () => {
  let s: TestServer;
  before(async () => {
    s = await start(SPELLINGS);
  });
  after(() => s.close());

  const ids = async (root: string, expression: string) => {
    const { status, body } = await get(
      `${root}/Rows?$filter=${encodeURIComponent(expression)}&$select=ID`,
    );
    assert.equal(status, 200, expression);
    const rows = root === s.v2 ? body.d.results : body.value;
    return rows.map((r: { ID: number }) => r.ID);
  };

  for (const expression of [
    "ID div 2 eq 0",
    "ID div 2 eq 1",
    "ID div 2 eq 2",
    "5 div 2 eq 2",
    "-5 div 2 eq -2",
    "ID mod 2 eq 1",
    "ID add 1 eq 3",
    "ID sub 1 eq 3",
    "ID mul 2 eq 8",
    "ID gt 3",
    "ID eq 3",
    "Big gt 1",
    "round(ID) eq 2",
  ]) {
    it(`${expression} finds what it finds on V4`, async () => {
      assert.deepEqual(
        await ids(s.v2, expression),
        await ids(s.v4, expression),
      );
    });
  }

  it("ID div 2 rounds towards zero", async () => {
    assert.deepEqual(await ids(s.v2, "ID div 2 eq 0"), [1]);
  });

  it("dividing it by zero is an error", async () => {
    const { status } = await get(
      `${s.v2}/Rows?$filter=${encodeURIComponent("ID div 0 eq 1")}`,
    );
    assert.equal(status, 400);
  });

  it("a key is read as before", async () => {
    assert.equal((await get(`${s.v2}/Rows(1)`)).status, 200);
  });

  it("it isn't an Int32 that overflows when it's written as an Int64", async () => {
    assert.deepEqual(
      await ids(s.v2, "ID add 3000000000L gt 0"),
      [1, 2, 3, 4, 5],
    );
  });

  for (const [expression, expected] of [
    ["3d div 2 eq 1.5", [1, 2, 3, 4, 5]],
    ["3f div 2 eq 1.5f", [1, 2, 3, 4, 5]],
    ["3.0 div 2 eq 1.5", [1, 2, 3, 4, 5]],
    ["3m div 2 eq 1m", []],
  ] as const) {
    it(`a suffix or a point still says what it is: ${expression}`, async () => {
      assert.deepEqual(await ids(s.v2, expression), expected);
    });
  }
});
