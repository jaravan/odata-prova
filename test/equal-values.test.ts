// A value written two ways is one value, wherever two are compared: 1.5 and 1.50, PT1H and
// PT60M, the two base64s of the same bytes.

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, send, start, type TestServer } from "./helpers.ts";

const MODEL = path.join(import.meta.dirname, "fixtures", "EqualKeys");

describe("rows related by a value written two ways (1.50 and 1.5, PT1H and PT60M)", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
  });
  afterEach(() => s.close());

  const kids = async (url: string) =>
    (await get(`${s.v4}/${url}`)).body.value.length;

  for (const [parent, set, url, kid, field] of [
    ["PDs", "Cs", "PDs(1.50)/Cs", "1.5", "F"],
    ["PTs", "Ts", "PTs(duration'PT1H')/Ts", "PT60M", "D"],
    ["PBs", "BKs", "PBs(binary'YQ==')/Bs", "YQ", "B"],
  ] as const) {
    const value = field === "F" ? "1.50" : field === "D" ? "PT1H" : "YQ==";
    it(`${kid} is a child of ${value}`, async () => {
      assert.equal(
        (await send("POST", `${s.v4}/${parent}`, { [field]: value })).status,
        201,
      );
      assert.equal(
        (await send("POST", `${s.v4}/${set}`, { ID: 1, [field]: kid })).status,
        201,
      );
      assert.equal(await kids(url), 1);
    });

    it(`a create under ${value} with the foreign key ${kid} is accepted`, async () => {
      await send("POST", `${s.v4}/${parent}`, { [field]: value });
      const res = await send("POST", `${s.v4}/${url}`, {
        ID: 2,
        [field]: kid,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });
  }

  it("a foreign key with another value is still a 400", async () => {
    await send("POST", `${s.v4}/PDs`, { F: "1.50" });
    const res = await send("POST", `${s.v4}/PDs(1.50)/Cs`, { ID: 3, F: "2" });
    assert.equal(res.status, 400);
  });

  it("a kid's parent, and $expand and $filter through it", async () => {
    await send("POST", `${s.v4}/PDs`, { F: "1.50" });
    await send("POST", `${s.v4}/Cs`, { ID: 4, F: "1.5" });
    const { body } = await get(`${s.v4}/Cs(4)?$expand=PD`);
    assert.ok(body.PD);
    const parents = await get(`${s.v4}/PDs?$filter=Cs/any()`);
    assert.equal(parents.body.value.length, 1);
  });

  it("a bind and a foreign key that write the same value differently agree", async () => {
    await send("POST", `${s.v4}/PTs`, { D: "PT1H" });
    const res = await send("POST", `${s.v4}/Ts`, {
      ID: 5,
      D: "PT60M",
      "PT@odata.bind": "PTs(duration'PT1H')",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it("a key is found however it's written", async () => {
    await send("POST", `${s.v4}/PTs`, { D: "PT1H" });
    assert.equal((await get(`${s.v4}/PTs(duration'PT60M')`)).status, 200);
  });
});
