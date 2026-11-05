// An unknown name is a 400 from the text of the request, whatever the rows are: not only when a
// row gets to it, which would make a mistake come and go with the data.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start, type TestServer } from "./helpers.ts";

const NONE = "Status eq 'none'";
const ONE = "PurchaseOrderId eq '4500000001'";

describe("an unknown name, whatever rows there are", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const status = async (query: string, set = "PurchaseOrderSet", root = s.v4) =>
    (await get(`${root}/${set}?${query.replaceAll(" ", "%20")}`)).status;

  for (const query of [
    `$filter=${ONE}&$orderby=Nope`,
    `$filter=${NONE}&$orderby=Nope`,
    `$filter=${ONE}&$orderby=Status,Nope desc`,
    `$filter=${NONE}&$orderby=Nope/Status`,
    `$filter=${NONE}&$orderby=Items/Material`,
    `$filter=${NONE} and Nope eq 1`,
    `$filter=${NONE} and Nope/Status eq 1`,
    `$filter=${NONE} and Items/any(i:i/Nope eq 1)`,
    `$filter=${NONE} and Items/any(i:i/PurchaseOrder/Nope eq 1)`,
    `$filter=${NONE} and Items/any(i:Nope eq 1)`,
    `$filter=${NONE} and Items/any(i:$it/Nope eq 1)`,
    `$filter=${NONE} and Nope/any()`,
    `$filter=${NONE} and Status/any()`,
    `$filter=${NONE} and Items/Nope/any()`,
    `$expand=Items($filter=PurchaseOrderId eq 'none' and Nope eq 1)`,
    `$expand=Items($filter=PurchaseOrderId eq 'none';$orderby=Nope)`,
    `$apply=filter(${NONE} and Nope eq 1)`,
    `$apply=filter(${NONE})/orderby(Nope)`,
  ]) {
    it(`${query} is a 400`, async () => {
      assert.equal(await status(query), 400);
    });
  }

  it("V2 too", async () => {
    const query = `$filter=${ONE}&$orderby=Nope`;
    assert.equal(await status(query, "PurchaseOrderSet", s.v2), 400);
    const filter = `$filter=${NONE} and Nope eq 1`;
    assert.equal(await status(filter, "PurchaseOrderSet", s.v2), 400);
  });

  for (const query of [
    `$filter=${NONE}&$orderby=Status desc`,
    `$filter=${ONE}&$orderby=Status`,
    `$filter=Status ne 'x' and Items/any(i:i/PurchaseOrder/Status ne 'x')`,
    `$filter=Items/any(i:$it/Status eq 'Open' and i/Material ne 'x')`,
    `$filter=Items/any(i:Status ne 'x')`,
    `$filter=Items/any(a:a/PurchaseOrder/Items/any(b:b/Material eq a/Material))`,
    `$filter=Items/any()`,
    `$compute=TotalAmount mul 2 as K&$filter=K gt 0&$orderby=K`,
    `$apply=groupby((Currency),aggregate($count as N))&$orderby=N`,
    `$apply=groupby((Currency),aggregate($count as N))/filter(N gt 0)`,
    `$apply=groupby((Currency),filter($these/aggregate($count) gt 0))`,
  ]) {
    it(`${query} is still fine`, async () => {
      assert.equal(await status(query), 200);
    });
  }

  it("a path through a navigation, on items", async () => {
    assert.equal(
      await status(
        "$orderby=PurchaseOrder/Status&$filter=PurchaseOrder/Status ne 'x'",
        "PurchaseOrderItemSet",
      ),
      200,
    );
  });

  it("items of a collection property, primitive or complex", async () => {
    const shapes = await start(
      path.join(import.meta.dirname, "fixtures", "Shapes"),
    );
    try {
      for (const filter of [
        "Tags/any(t:t eq 'a')",
        "Stops/any(s:s/City eq 'a')",
      ])
        assert.equal(
          (
            await get(
              `${shapes.v4}/Items?$filter=${encodeURIComponent(filter)}`,
            )
          ).status,
          200,
          filter,
        );
    } finally {
      await shapes.close();
    }
  });
});
