import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get } from "./helpers.js";

// Real services often declare a few navigations the server cannot join (here a
// many-to-many link). They are switched off; the rest of the service keeps working.
describe("navigations the server cannot resolve are disabled, not fatal", () => {
  let s;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "ManyToMany"));
  });
  after(() => s.close());

  it("starts, records why, and serves the rest", async () => {
    assert.equal(s.model.warnings.length, 2);
    assert.match(
      s.model.warnings[0],
      /Student\.Courses: cannot derive join condition/,
    );
    assert.equal((await get(`${s.v2}/Students(1)`)).body.d.Name, "Ada");
    assert.equal((await get(`${s.v4}/Courses`)).body.value.length, 1);
  });

  it("using a disabled navigation is a 501 that says why, on every route", async () => {
    for (const url of [
      `${s.v2}/Students(1)/Courses`,
      `${s.v2}/Students?$expand=Courses`,
      `${s.v4}/Students?$expand=Courses`,
      `${s.v4}/Courses?$filter=Students/Name eq 'Ada'`,
    ]) {
      const r = await get(url);
      assert.equal(r.status, 501, url);
      assert.match(
        JSON.stringify(r.body),
        /Navigation (Courses|Students) is not supported/,
        url,
      );
    }
  });
});
