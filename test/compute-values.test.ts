// What arithmetic and $compute write has to be a value of the type they say it is: an integer
// in its type's range, and a time as fine as the property it's copied from.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const MAX_INT64 = "9223372036854775807";
const MIN_INT64 = "-9223372036854775808";

// JSON.parse would round the digits these tests are about, so they read the text
const STRINGS = { Accept: "application/json;IEEE754Compatible=true" };

describe("integer arithmetic stays in its type's range", () => {
  let s: Awaited<ReturnType<typeof start>>;
  before(async () => {
    s = await start(path.join(FIXTURES, "EdmTypes"));
    await send("POST", `${s.v4}/Values`, { ID: 900, Big: MAX_INT64 });
    await send("POST", `${s.v4}/Values`, { ID: 901, Big: MIN_INT64 });
  });
  after(() => s.close());

  const compute = (id: number, expression: string) =>
    fetch(
      `${s.v4}/Values(${id})?$select=K&$compute=${encodeURIComponent(`${expression} as K`)}`,
      { headers: STRINGS },
    );
  const value = async (id: number, expression: string) => {
    const res = await compute(id, expression);
    assert.equal(res.status, 200, expression);
    return ((await res.json()) as { K: unknown }).K;
  };

  for (const [id, expression] of [
    [900, "Big add 1"],
    [900, "Big mul 2"],
    [901, "Big sub 1"],
    [901, "Big div -1"],
    [901, "Big mul -1"],
    [901, "-Big"],
    [900, `${MAX_INT64} add 1`],
    [900, "2147483647 add 1"],
    [900, "ID mul 2147483647"],
    [900, "-2147483648 sub 1"],
  ] as const) {
    it(`${expression} is a 400`, async () => {
      const res = await compute(id, expression);
      assert.equal(res.status, 400);
      const { error } = (await res.json()) as { error: { message: string } };
      assert.match(error.message, /\$compute: .*Edm\.Int(32|64)/);
    });
  }

  for (const [id, expression, expected] of [
    [900, "Big sub 1", "9223372036854775806"],
    [901, "Big add 1", "-9223372036854775807"],
    [900, "-Big", "-9223372036854775807"],
    [900, "Big add 0", MAX_INT64],
    [901, "Big add 0", MIN_INT64],
    [900, "2147483646 add 1", 2147483647],
    [900, "-2147483647 sub 1", -2147483648],
    [900, "2147483647 add 3000000000", "5147483647"],
  ] as const) {
    it(`${expression} up to its limit is still a value`, async () => {
      assert.equal(await value(id, expression), expected);
    });
  }

  it("a Decimal has no such limit", async () => {
    assert.equal(await value(900, "Big mul 2.5"), "23058430092136939517.5");
    assert.equal(await value(900, "ID mul 2147483647.0"), "1932735282300");
  });

  it("a number too large for an Int32 is an Int64, in V2 too", async () => {
    for (const root of [s.v4, s.v2]) {
      const res = await fetch(
        `${root}/Values?$filter=${encodeURIComponent("ID add 3000000000 gt 0")}`,
      );
      assert.equal(res.status, 200, root);
    }
  });

  it("in a $filter, too", async () => {
    const { status } = await get(
      `${s.v4}/Values?$filter=${encodeURIComponent("Big add 1 gt 0")}`,
    );
    assert.equal(status, 400);
  });

  it("a $filter that doesn't reach such a row is fine", async () => {
    const { status } = await get(
      `${s.v4}/Values?$filter=${encodeURIComponent("ID eq 2 and Big add 1 gt 0")}`,
    );
    assert.equal(status, 200);
  });
});
