// What a request says twice, and a parameter that can't be null.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start, type TestServer } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

describe("an option given twice", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(FIXTURES, "OperationsV2"));
  });
  after(() => s.close());

  for (const url of [
    "PurchaseOrderSet?!deltatoken=1&!deltatoken=2",
    "PurchaseOrderSet?$top=1&$top=2",
    "GetStatusText?Status=a&Status=b",
  ])
    it(`${url} is a 400`, async () => {
      const { status, body } = await get(`${s.v2}/${url}`);
      assert.equal(status, 400);
      assert.match(body.error.message.value, /more than once/);
    });
});
