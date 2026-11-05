import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  start,
  get,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";
import { Queue } from "../lib/queue.ts";
import { MAX_WORK, spend } from "../lib/work.ts";

const q = encodeURIComponent;
const SET = "PurchaseOrderSet";

// Each level multiplies the text by 8, for 40 more bytes of URL
const replaces = (levels: number) =>
  "replace(".repeat(levels) + "'aaaaaaaa'" + ",'a','aaaaaaaa')".repeat(levels);
// Each level goes through every item of every order again
const lambdas = (levels: number) =>
  `Items/any(a:${"a/PurchaseOrder/Items/any(b:b/PurchaseOrder/Items/any(a:".repeat(levels)}false${"))".repeat(levels)})`;
// Each level reads the items of every order it reached again
const expands = (levels: number) =>
  `${"Items($expand=PurchaseOrder($expand=".repeat(levels)}Items${"))".repeat(levels)}`;

// Each concat copies the rows once for each sequence, so these multiply
const concats = (sequences: number, levels: number) =>
  Array(levels)
    .fill(`concat(${Array(sequences).fill("identity").join(",")})`)
    .join("/");

describe("a request that would take too much work -> 400, and the server carries on", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const refused = async (url: string) => {
    const r = await get(url);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "TooMuchWork");
    assert.equal((await get(`${s.base}/healthz`)).status, 200);
  };

  it("rows that multiply with each $apply concat", async () => {
    await refused(`${s.v4}/${SET}?$apply=${q(concats(200, 3))}&$top=1`);
    await refused(`${s.v4}/${SET}?$apply=${q(concats(200, 4))}&$top=1`);
  });

  it("whatever the sequences are, and whatever comes after", async () => {
    const sequence = Array(200).fill("compute(1 as K)").join(",");
    const apply = `concat(${sequence})/concat(${sequence.replaceAll("K", "L")})/${concats(200, 1)}`;
    await refused(`${s.v4}/${SET}?$apply=${q(apply)}&$top=1`);
  });

  it("in a groupby's sequence too", async () => {
    await refused(
      `${s.v4}/${SET}?$apply=${q(`groupby((Status),${concats(200, 3)})`)}&$top=1`,
    );
  });

  it("the rows a concat is for are fine", async () => {
    const res = await get(
      `${s.v4}/${SET}?$apply=${q(concats(200, 2))}&$count=true&$top=1`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body["@odata.count"], 5 * 200 * 200);
    const paged = await get(
      `${s.v4}/${SET}?$apply=${q("concat(aggregate($count as N),identity)")}`,
    );
    assert.equal(paged.body.value.length, 6);
  });

  it("text that grows with each replace, in $filter and in $compute", async () => {
    await refused(`${s.v4}/${SET}?$filter=${q(`${replaces(25)} eq 'x'`)}`);
    await refused(`${s.v4}/${SET}?$compute=${q(`${replaces(25)} as K`)}`);
    await refused(`${s.v2}/${SET}?$filter=${q(`${replaces(25)} eq 'x'`)}`);
  });

  it("text that doubles with each compute in $apply", async () => {
    const doubles = Array.from(
      { length: 40 },
      (_, i) => `compute(concat(A${i},A${i}) as A${i + 1})`,
    ).join("/");
    await refused(
      `${s.v4}/${SET}?$apply=${q(`compute(concat(Status,Status) as A0)/${doubles}`)}`,
    );
  });

  it("lambdas that go round a navigation cycle", async () => {
    await refused(`${s.v4}/${SET}?$filter=${q(lambdas(14))}`);
  });

  it("an $expand that goes round a navigation cycle", async () => {
    await refused(`${s.v4}/${SET}?$expand=${q(expands(30))}`);
    await refused(
      `${s.v4}/${SET}?$expand=${q(`Items($filter=${lambdas(14).replace("Items/any(a:", "PurchaseOrder/Items/any(a:")})`)}`,
    );
  });

  it("in a $batch, the part that fails answers as any other", async () => {
    const { text } = await batch(s.v4, [
      { method: "GET", url: `${SET}?$filter=${q(`${replaces(25)} eq 'x'`)}` },
      { method: "GET", url: `${SET}/$count` },
    ]);
    const [first, second] = batchResponses(text);
    assert.equal(first.status, 400);
    assert.equal(first.body.error.code, "TooMuchWork");
    assert.equal(second.status, 200);
  });

  it("what a real client asks for is well inside the limit", async () => {
    const r = await get(
      `${s.v4}/${SET}?$filter=${q(`${replaces(3)} ne 'x' and Items/any(i:i/PurchaseOrder/Items/any(j:true))`)}&$expand=${q(expands(4))}`,
    );
    assert.equal(r.status, 200);
    assert.ok(r.body.value.length > 0);
  });
});

describe("the work a request may do", () => {
  it("is counted for each turn in the queue, which a whole $batch is", async () => {
    const queue = new Queue();
    await queue.run(() => {
      spend(MAX_WORK);
      assert.throws(() => spend(1), /too much work/);
    });
    await queue.run(() => spend(MAX_WORK));
  });
});
