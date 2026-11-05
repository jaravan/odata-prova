// What a write says about a family of rows is done, or refused: an unlink names a link that
// exists, and related entities in a body are created or are a 400, never dropped.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start, type TestServer } from "./helpers.ts";

const FAMILIES = path.join(import.meta.dirname, "fixtures", "Families");

describe("families", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(FAMILIES);
    await send("POST", `${s.v4}/Ps`, { ID: 700 });
    await send("POST", `${s.v4}/Ps`, { ID: 701 });
    await send("POST", `${s.v4}/Ks`, { ID: 900, PID: 700 });
  });
  afterEach(() => s.close());

  const parentOf = async (id: number) =>
    (await get(`${s.v4}/Ks(${id})`)).body.PID;

  describe("unlinking with $id", () => {
    it("someone else's kid is a 404, and stays theirs", async () => {
      const url = `${s.v4}/Ps(701)/Kids/$ref?$id=Ks(900)`;
      assert.equal((await send("DELETE", url)).status, 404);
      assert.equal(await parentOf(900), 700);
    });

    it("its own kid is unlinked", async () => {
      const url = `${s.v4}/Ps(700)/Kids/$ref?$id=Ks(900)`;
      assert.equal((await send("DELETE", url)).status, 204);
      assert.equal(await parentOf(900), null);
    });
  });
});
