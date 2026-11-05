// A mistake gets a message about the mistake, not one about this server's JavaScript.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { get, start, type TestServer } from "./helpers.ts";

// What a message has no business saying
const INTERNALS =
  /undefined|Cannot read|is not a function|not iterable|Invalid time value|null \(/;

const ARITY: Record<string, [number, number]> = {
  tolower: [1, 1],
  toupper: [1, 1],
  trim: [1, 1],
  length: [1, 1],
  year: [1, 1],
  month: [1, 1],
  day: [1, 1],
  hour: [1, 1],
  minute: [1, 1],
  second: [1, 1],
  date: [1, 1],
  time: [1, 1],
  round: [1, 1],
  floor: [1, 1],
  ceiling: [1, 1],
  concat: [2, 2],
  contains: [2, 2],
  startswith: [2, 2],
  endswith: [2, 2],
  substringof: [2, 2],
  indexof: [2, 2],
  substring: [2, 3],
  replace: [3, 3],
  now: [0, 0],
};

describe("a function called with the wrong arguments", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const filter = async (expression: string, root = s.v4) => {
    const res = await fetch(
      `${root}/PurchaseOrderSet?$filter=${encodeURIComponent(expression)}`,
    );
    return { status: res.status, text: await res.text() };
  };

  for (const [name, [min, max]] of Object.entries(ARITY))
    for (const count of [0, 1, 2, 3, 4]) {
      if (count >= min && count <= max) continue;
      const call = `${name}(${Array(count).fill("Status").join(",")}) eq 1`;
      it(`${call} says how many it takes`, async () => {
        const { status, text } = await filter(call);
        assert.equal(status, 400);
        assert.match(text, new RegExp(`${name} takes .*argument`));
        assert.doesNotMatch(text, INTERNALS);
      });
    }

  it("whether or not a row gets to it", async () => {
    const { status } = await filter("TotalAmount lt 0 and tolower() eq 'a'");
    assert.equal(status, 400);
  });

  it("the right number of them still works", async () => {
    for (const call of [
      "substring(Status,1) ne 'x'",
      "substring(Status,1,2) ne 'x'",
      "concat(Status,Status) ne 'x'",
      "replace(Status,'a','b') ne 'x'",
      "now() gt 2000-01-01T00:00:00Z",
    ])
      assert.equal((await filter(call)).status, 200, call);
  });

  for (const call of [
    "date('x') eq 2025-01-01",
    "time('x') eq 10:00:00",
    "date(Status) eq 2025-01-01",
    "year('x') eq 2025",
    "month(Status) eq 1",
    "hour('x') eq 1",
    "year(1) eq 2025",
    "day(true) eq 1",
  ]) {
    it(`${call} says it needs a date`, async () => {
      const { status, text } = await filter(call);
      assert.equal(status, 400);
      assert.match(text, /needs a date or a time/);
      assert.doesNotMatch(text, INTERNALS);
    });
  }

  it("a date still is one, from a property or a literal", async () => {
    assert.equal((await filter("year(OrderDate) gt 2000")).status, 200);
    assert.equal((await filter("year(2025-01-01) eq 2025")).status, 200);
    assert.equal((await filter("hour(10:30:00) eq 10")).status, 200);
    assert.equal(
      (await filter("year(datetime'2025-01-01T00:00:00') gt 2000", s.v2))
        .status,
      200,
    );
  });

  it("$compute reports them too", async () => {
    const { status, body } = await get(
      `${s.v4}/PurchaseOrderSet?$compute=${encodeURIComponent("tolower() as K")}`,
    );
    assert.equal(status, 400);
    assert.match(body.error.message, /\$compute.*tolower takes/);
  });
});
