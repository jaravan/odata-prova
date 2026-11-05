// A duration that can't be read is a 400: read as nothing, it would equal a null one.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start, type TestServer } from "./helpers.ts";

const SPELLINGS = path.join(import.meta.dirname, "fixtures", "Spellings");

describe("a duration in a $filter", () => {
  let s: TestServer;
  before(async () => {
    s = await start(SPELLINGS);
  });
  after(() => s.close());

  const filter = (expression: string) =>
    get(`${s.v4}/Rows?$filter=${encodeURIComponent(expression)}&$select=ID`);
  const ids = async (expression: string) => {
    const { status, body } = await filter(expression);
    assert.equal(status, 200, expression);
    return body.value.map((r: { ID: number }) => r.ID);
  };

  for (const expression of [
    "Took eq duration'garbage'",
    "Took ne duration'garbage'",
    "Took gt duration'garbage'",
    "Took eq duration'P1Y'",
    "Took eq duration''",
    "Took eq 'x'",
    "Took ne 'x'",
    "Took lt 'x'",
    "Took eq 5",
    "Took in ('x')",
    "'x' eq Took",
  ]) {
    it(`${expression} is a 400`, async () => {
      assert.equal((await filter(expression)).status, 400);
    });
  }

  for (const [expression, expected] of [
    ["Took eq duration'PT1H'", [1, 2, 3]],
    ["Took eq duration'PT60M'", [1, 2, 3]],
    ["Took gt duration'PT1H'", [4]],
    ["Took eq 'PT1H'", [1, 2, 3]],
    ["Took eq null", [5]],
    ["Took ne null", [1, 2, 3, 4]],
  ] as const) {
    it(`${expression} still finds its rows`, async () => {
      assert.deepEqual(await ids(expression), expected);
    });
  }

  it("a row with a null duration is never equal to a value", async () => {
    assert.deepEqual(await ids("ID eq 5 and Took eq duration'PT1H'"), []);
  });
});
