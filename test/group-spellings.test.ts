// One value with several spellings is one value to groupby and countdistinct, as it is to eq:
// 0.3 and 0.30, a Guid in either case, PT1H and PT60M.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start } from "./helpers.ts";

const SPELLINGS = path.join(import.meta.dirname, "fixtures", "Spellings");

type Rows = { value: Record<string, unknown>[] };

describe("values with several spellings", () => {
  let s: Awaited<ReturnType<typeof start>>;
  before(async () => {
    s = await start(SPELLINGS);
  });
  after(() => s.close());

  const apply = async (transformations: string) => {
    const { status, body } = await get(
      `${s.v4}/Rows?$apply=${encodeURIComponent(transformations)}`,
    );
    assert.equal(status, 200);
    return (body as Rows).value;
  };
  const counts = async (property: string) =>
    (await apply(`groupby((${property}),aggregate($count as N))`)).map((r) =>
      Number(r.N),
    );
  const distinct = async (property: string) =>
    Number(
      (await apply(`aggregate(${property} with countdistinct as N)`))[0].N,
    );

  for (const property of ["Amount", "Ref", "Took", "At", "Tod"]) {
    it(`groupby puts every spelling of a ${property} in one group`, async () => {
      assert.deepEqual(await counts(property), [3, 1, 1]);
    });
    it(`countdistinct counts every spelling of a ${property} once`, async () => {
      assert.equal(await distinct(property), 2);
    });
  }

  it("a group shows the first spelling of its value", async () => {
    const [row] = await apply("groupby((Amount),aggregate($count as N))");
    assert.equal(row.Amount, 0.3);
    const [guid] = await apply("groupby((Ref),aggregate($count as N))");
    assert.equal(guid.Ref, "aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("a group holds the same rows eq finds", async () => {
    const { body } = await get(
      `${s.v4}/Rows?$filter=${encodeURIComponent("Amount eq 0.3")}`,
    );
    assert.deepEqual(await counts("Amount"), [
      (body as Rows).value.length,
      1,
      1,
    ]);
  });

  it("groups by several properties at once", async () => {
    const rows = await apply("groupby((Amount,Ref),aggregate($count as N))");
    assert.deepEqual(
      rows.map((r) => Number(r.N)),
      [3, 1, 1],
    );
  });

  it("a groupby with a sequence runs it once for each value", async () => {
    const rows = await apply("groupby((Amount),top(1))");
    assert.deepEqual(
      rows.map((r) => r.ID),
      [1, 4, 5],
    );
  });

  it("a custom aggregate sees the rows sharing a Guid in either case", async () => {
    const [shared] = await apply("filter(ID le 3)/aggregate(Ref)");
    assert.equal(shared.Ref, "aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("text is still case-sensitive", async () => {
    assert.deepEqual(await counts("Text"), [2, 1, 1, 1]);
    assert.equal(await distinct("Text"), 3);
  });

  it("Int64 values a double can't tell apart stay apart", async () => {
    assert.deepEqual(await counts("Big"), [2, 1, 1, 1]);
    assert.equal(await distinct("Big"), 3);
  });

  it("null is a group of its own, and not a value countdistinct counts", async () => {
    const rows = await apply("groupby((Amount),aggregate($count as N))");
    assert.equal(rows.at(-1)!.Amount, null);
    assert.equal(await distinct("Amount"), 2);
  });
});
