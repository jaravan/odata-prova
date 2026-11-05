// topsum, bottomsum, toppercent and bottompercent add up decimals exactly: as doubles, a large
// amount and its negative cancel out, and what's between them is lost.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start } from "./helpers.ts";

const EDM_TYPES = path.join(import.meta.dirname, "fixtures", "EdmTypes");
const LARGE = "12345678901234567890.123456789";

describe("ranking by a total", () => {
  let s: Awaited<ReturnType<typeof start>>;
  before(async () => {
    s = await start(EDM_TYPES);
    const rows: [number, string][] = [
      [101, LARGE],
      [102, "0.3"],
      [103, `-${LARGE}`],
      [201, "0.7"],
      [202, "0.1"],
      [203, "0.1"],
      [204, "0.1"],
      [205, "0.05"],
    ];
    for (const [ID, Amount] of rows)
      await send("POST", `${s.v4}/Values`, { ID, Amount, V: Number(Amount) });
  });
  after(() => s.close());

  const ids = async (from: number, to: number, transformation: string) => {
    const filter = `filter(ID ge ${from} and ID le ${to})`;
    const { status, body } = await get(
      `${s.v4}/Values?$apply=${encodeURIComponent(`${filter}/${transformation}`)}`,
    );
    assert.equal(status, 200);
    return (body as { value: { ID: number }[] }).value.map((r) => r.ID);
  };
  const cancelling = (transformation: string) => ids(101, 103, transformation);
  const tenths = (transformation: string) => ids(201, 205, transformation);

  it("toppercent keeps what the small amount adds up to", async () => {
    assert.deepEqual(await cancelling("toppercent(50,Amount)"), [101]);
  });

  it("bottompercent goes through every row to reach it", async () => {
    assert.deepEqual(
      await cancelling("bottompercent(50,Amount)"),
      [103, 102, 101],
    );
  });

  it("topsum stops as soon as tenths add up to the sum", async () => {
    assert.deepEqual(await tenths("topsum(1,Amount)"), [201, 202, 203, 204]);
  });

  it("toppercent stops at exactly its share of the total", async () => {
    // 80% of 1.05 is 0.84, which 0.7 + 0.1 doesn't reach and 0.7 + 0.1 + 0.1 does
    assert.deepEqual(await tenths("toppercent(80,Amount)"), [201, 202, 203]);
  });

  it("a percentage may have a fraction", async () => {
    // 66.6% of 1.05 is 0.6993, which 0.7 reaches
    assert.deepEqual(await tenths("toppercent(66.6,Amount)"), [201]);
    // 66.7% of it is 0.70035, which it doesn't
    assert.deepEqual(await tenths("toppercent(66.7,Amount)"), [201, 202]);
  });

  it("a sum too large to write as a decimal is still a sum", async () => {
    const sum = `1${"0".repeat(300)}`;
    assert.equal((await tenths(`topsum(${sum},Amount)`)).length, 5);
  });

  it("toppercent(0) keeps nothing, and toppercent(100) every row", async () => {
    assert.deepEqual(await tenths("toppercent(0,Amount)"), []);
    assert.equal((await tenths("toppercent(100,Amount)")).length, 5);
  });

  it("a Double is added up as doubles, which it is", async () => {
    // 0.7 + 0.1 + 0.1 + 0.1 is 0.9999999999999999, so the last row is needed too
    assert.equal((await tenths("topsum(1,V)")).length, 5);
  });
});
