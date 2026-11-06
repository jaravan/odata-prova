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

  describe("a create with a navigation", () => {
    for (const Kids of [{ ID: 1 }, "nonsense", 5, 0, "", false, true])
      it(`Kids: ${JSON.stringify(Kids)} isn't a collection`, async () => {
        const res = await send("POST", `${s.v4}/Ps`, { ID: 800, Kids });
        assert.equal(res.status, 400);
        assert.equal((await get(`${s.v4}/Ps(800)`)).status, 404);
      });

    for (const Parent of [0, "", false])
      it(`Parent: ${JSON.stringify(Parent)} isn't an entity`, async () => {
        const res = await send("POST", `${s.v4}/Ks`, { ID: 801, Parent });
        assert.equal(res.status, 400);
      });

    it("an array is created, V2's results too", async () => {
      const body = { ID: 802, Kids: [{ ID: 960 }] };
      assert.equal((await send("POST", `${s.v4}/Ps`, body)).status, 201);
      assert.equal(await parentOf(960), 802);
      const v2 = { ID: 803, Kids: { results: [{ ID: 961 }] } };
      assert.equal((await send("POST", `${s.v2}/Ps`, v2)).status, 201);
      assert.equal(await parentOf(961), 803);
    });

    it("nothing to create is fine", async () => {
      for (const [i, Kids] of [[], null, { results: [] }].entries())
        assert.equal(
          (await send("POST", `${s.v4}/Ps`, { ID: 810 + i, Kids })).status,
          201,
        );
      const deferred = { __deferred: { uri: "x" } };
      assert.equal(
        (await send("POST", `${s.v2}/Ps`, { ID: 820, Kids: deferred })).status,
        201,
      );
    });
  });

  describe("an update with related entities", () => {
    for (const [method, body] of [
      ["PATCH", { Kids: [{ ID: 950 }] }],
      ["PUT", { Kids: [{ ID: 950 }] }],
      ["PATCH", { Kids: { results: [{ ID: 950 }] } }],
      ["PATCH", { Kids: "nonsense" }],
    ] as const)
      it(`${method} ${JSON.stringify(body)} is a 400`, async () => {
        const res = await send(method, `${s.v4}/Ps(700)`, body);
        assert.equal(res.status, 400);
        assert.match(res.body.error.message, /Kids/);
        assert.equal((await get(`${s.v4}/Ks(950)`)).status, 404);
      });

    it("a to-one is refused too, and changes nothing", async () => {
      const res = await send("PATCH", `${s.v4}/Ks(900)`, {
        I1: 5,
        Parent: { ID: 701 },
      });
      assert.equal(res.status, 400);
      assert.equal((await get(`${s.v4}/Ks(900)`)).body.I1, null);
    });

    it("what holds nothing to lose is fine", async () => {
      for (const Kids of [[], null, { results: [] }])
        assert.equal(
          (await send("PATCH", `${s.v4}/Ps(700)`, { Kids })).status,
          204,
        );
      assert.equal(
        (
          await send("PATCH", `${s.v2}/Ps(700)`, {
            Kids: { __deferred: { uri: "x" } },
          })
        ).status,
        204,
      );
    });

    it("links by reference still are links", async () => {
      assert.equal(
        (
          await send("PATCH", `${s.v4}/Ks(900)`, {
            "Parent@odata.bind": "Ps(701)",
          })
        ).status,
        204,
      );
      assert.equal(await parentOf(900), 701);
      assert.equal(
        (
          await send("PATCH", `${s.v2}/Ks(900)`, {
            Parent: { __metadata: { uri: "Ps(700)" } },
          })
        ).status,
        204,
      );
      assert.equal(await parentOf(900), 700);
    });
  });
});

describe("a to-one link and what a create can't mean", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(FAMILIES);
    await send("POST", `${s.v4}/Ps`, { ID: 800 });
    await send("POST", `${s.v4}/Ps`, { ID: 801 });
    await send("POST", `${s.v4}/Ks`, { ID: 998, PID: 800 });
  });
  afterEach(() => s.close());

  const parent = async () => (await get(`${s.v4}/Ks(998)`)).body.PID;

  it("$id naming another parent is a 404, and the link stays", async () => {
    const url = `${s.v4}/Ks(998)/Parent/$ref?$id=Ps(801)`;
    assert.equal((await send("DELETE", url)).status, 404);
    assert.equal(await parent(), 800);
  });

  it("$id naming its parent unlinks, and so does no $id", async () => {
    const url = `${s.v4}/Ks(998)/Parent/$ref`;
    assert.equal((await send("DELETE", `${url}?$id=Ps(800)`)).status, 204);
    assert.equal(await parent(), null);
    await send("PATCH", `${s.v4}/Ks(998)`, { PID: 800 });
    assert.equal((await send("DELETE", url)).status, 204);
    assert.equal(await parent(), null);
  });

  it("a to-one bound and given inline is a 400, and creates nothing", async () => {
    const res = await send("POST", `${s.v4}/Ks`, {
      ID: 999,
      "Parent@odata.bind": "Ps(801)",
      Parent: { ID: 802 },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Parent/);
    assert.equal((await get(`${s.v4}/Ps(802)`)).status, 404);
    assert.equal((await get(`${s.v4}/Ks(999)`)).status, 404);
  });

  it("either alone still works", async () => {
    const bound = { ID: 990, "Parent@odata.bind": "Ps(801)" };
    assert.equal((await send("POST", `${s.v4}/Ks`, bound)).status, 201);
    const inline = { ID: 991, Parent: { ID: 803 } };
    assert.equal((await send("POST", `${s.v4}/Ks`, inline)).status, 201);
  });

  for (const field of ["Kids@delta", "Kids@odata.delta"]) {
    it(`PATCH with ${field} says it isn't done`, async () => {
      const res = await send("PATCH", `${s.v4}/Ps(800)`, {
        [field]: [{ ID: 950 }],
      });
      assert.equal(res.status, 501);
      assert.match(res.body.error.message, /delta/i);
      assert.equal((await get(`${s.v4}/Ks(950)`)).status, 404);
    });

    it(`POST with ${field} too`, async () => {
      const res = await send("POST", `${s.v4}/Ps`, {
        ID: 810,
        [field]: [{ ID: 950 }],
      });
      assert.equal(res.status, 501);
    });
  }

  it("other annotations are still fine", async () => {
    const res = await send("PATCH", `${s.v4}/Ps(800)`, {
      "I1@odata.type": "#Int32",
      I1: 1,
    });
    assert.equal(res.status, 204);
  });
});

describe("what a create says twice", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(FAMILIES);
    await send("POST", `${s.v4}/Ps`, { ID: 810 });
    await send("POST", `${s.v4}/Ps`, { ID: 811 });
  });
  afterEach(() => s.close());

  it("@bind is the same as @odata.bind", async () => {
    const res = await send("POST", `${s.v4}/Ks`, {
      ID: 1,
      "Parent@bind": "Ps(810)",
    });
    assert.equal(res.status, 201);
    assert.equal((await get(`${s.v4}/Ks(1)`)).body.PID, 810);
    const parent = await send("POST", `${s.v4}/Ps`, {
      ID: 812,
      "Kids@bind": ["Ks(1)"],
    });
    assert.equal(parent.status, 201);
    assert.equal((await get(`${s.v4}/Ks(1)`)).body.PID, 812);
  });

  it("a foreign key against a bind is a 400", async () => {
    const res = await send("POST", `${s.v4}/Ks`, {
      ID: 2,
      PID: 811,
      "Parent@odata.bind": "Ps(810)",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /PID/);
  });

  it("the same foreign key is fine", async () => {
    const res = await send("POST", `${s.v4}/Ks`, {
      ID: 3,
      PID: 810,
      "Parent@odata.bind": "Ps(810)",
    });
    assert.equal(res.status, 201);
  });

  it("a nested kid's against its new parent is a 400, and creates nothing", async () => {
    const res = await send("POST", `${s.v4}/Ps`, {
      ID: 813,
      Kids: [{ ID: 4, PID: 810 }],
    });
    assert.equal(res.status, 400);
    assert.equal((await get(`${s.v4}/Ps(813)`)).status, 404);
  });

  it("against the parent in the URL too", async () => {
    const res = await send("POST", `${s.v4}/Ps(811)/Kids`, { ID: 5, PID: 810 });
    assert.equal(res.status, 400);
    const fine = await send("POST", `${s.v4}/Ps(811)/Kids`, {
      ID: 6,
      PID: 811,
    });
    assert.equal(fine.status, 201);
  });
});

describe("a create answered with no content", () => {
  it("says which entity with OData-EntityId, in V4", async () => {
    const s = await start(FAMILIES);
    try {
      const res = await send(
        "POST",
        `${s.v4}/Ps`,
        { ID: 1 },
        { prefer: "return=minimal" },
      );
      assert.equal(res.status, 204);
      assert.equal(
        res.headers.get("odata-entityid"),
        res.headers.get("location"),
      );
      assert.match(res.headers.get("odata-entityid")!, /Ps\(1\)$/);
      const v2 = await send(
        "POST",
        `${s.v2}/Ps`,
        { ID: 2 },
        { prefer: "return=minimal" },
      );
      assert.equal(v2.headers.get("odata-entityid"), null);
    } finally {
      await s.close();
    }
  });
});
