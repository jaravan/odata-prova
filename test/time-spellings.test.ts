// A time is the same time however many zeros end its fraction, as eq has it for a decimal:
// 10:00:00.5 and 10:00:00.500, time'PT10H0M0.5S' and time'PT10H0M0.500S'.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start, type TestServer } from "./helpers.ts";

const SPELLINGS = path.join(import.meta.dirname, "fixtures", "Spellings");

describe("a time, however its fraction is written", () => {
  let s: TestServer;
  before(async () => {
    s = await start(SPELLINGS);
  });
  after(() => s.close());

  const ids = async (root: string, query: string) => {
    const { status, body } = await get(
      `${root}/Rows?${query}&$select=ID`.replaceAll(" ", "%20"),
    );
    assert.equal(status, 200, query);
    return (root === s.v2 ? body.d.results : body.value).map(
      (r: { ID: number }) => r.ID,
    );
  };

  for (const literal of [
    "time'PT10H0M0.5S'",
    "time'PT10H0M0.50S'",
    "time'PT10H0M0.500S'",
    "time'PT10H00M00.5S'",
  ])
    it(`V2: ${literal} is one time`, async () => {
      assert.deepEqual(await ids(s.v2, `$filter=Tod eq ${literal}`), [1, 2, 3]);
    });

  for (const literal of ["10:00:00.5", "10:00:00.50", "10:00:00.500"])
    it(`V4: ${literal} is one time`, async () => {
      assert.deepEqual(await ids(s.v4, `$filter=Tod eq ${literal}`), [1, 2, 3]);
    });

  it("V2: gt, lt, ge and ne agree with eq", async () => {
    const at = "time'PT10H0M0.500S'";
    assert.deepEqual(await ids(s.v2, `$filter=Tod gt ${at}`), []);
    assert.deepEqual(await ids(s.v2, `$filter=Tod lt ${at}`), [4]);
    assert.deepEqual(await ids(s.v2, `$filter=Tod ge ${at}`), [1, 2, 3]);
    assert.deepEqual(await ids(s.v2, `$filter=Tod ne ${at}`), [4, 5]);
  });

  it("a time with no fraction is before one with a fraction, and zeros in the time itself stay", async () => {
    const whole = "time'PT10H0M0S'";
    assert.deepEqual(await ids(s.v2, `$filter=Tod gt ${whole}`), [1, 2, 3, 4]);
    assert.deepEqual(await ids(s.v2, `$filter=Tod eq ${whole}`), []);
    assert.deepEqual(
      await ids(s.v2, "$filter=Tod eq time'PT10H0M0.250S'"),
      [4],
    );
  });

  it("$orderby keeps a time's spellings together", async () => {
    const sorted = await ids(s.v2, "$orderby=Tod desc,ID");
    assert.deepEqual(sorted, [1, 2, 3, 4, 5]);
  });
});
