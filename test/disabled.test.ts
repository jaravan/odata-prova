import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, type TestServer } from "./helpers.ts";

// Real services can declare navigations the server cannot join (here one to an entity type
// no entity set holds). They are switched off; the rest of the service keeps working.
describe("navigations the server cannot resolve are disabled, not fatal", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "Disabled"));
  });
  after(() => s.close());

  it("starts, records why, and serves the rest", async () => {
    assert.deepEqual(s.model.warnings, [
      "navigation disabled: Student.Advisor: no entity set for D.Advisor",
    ]);
    assert.equal((await get(`${s.v2}/Students(1)`)).body.d.Name, "Ada");
    assert.equal((await get(`${s.v4}/Students`)).body.value.length, 2);
  });

  it("using a disabled navigation is a 501 that says why, on every route", async () => {
    for (const url of [
      `${s.v2}/Students(1)/Advisor`,
      `${s.v2}/Students?$expand=Advisor`,
      `${s.v4}/Students?$expand=Advisor`,
      `${s.v4}/Students?$filter=Advisor/Name eq 'Ada'`,
    ]) {
      const r = await get(url);
      assert.equal(r.status, 501, url);
      assert.match(
        JSON.stringify(r.body),
        /Navigation Advisor is not supported/,
        url,
      );
    }
  });
});
