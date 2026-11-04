import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";

const MODEL = path.join(import.meta.dirname, "fixtures", "Shapes");

describe("a path that doesn't fit what it names", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  it("/$count, /$value and /$ref alone name nothing: a 404 from the service", async () => {
    for (const root of [s.v4, s.v2])
      for (const name of ["$count", "$value"]) {
        const res = await get(`${root}/${name}`);
        assert.equal(res.status, 404, name);
        assert.ok(res.body.error);
      }
    assert.equal((await get(`${s.v4}/$ref`)).status, 404);
  });

  it("an entity has no $count, on either protocol", async () => {
    for (const root of [s.v4, s.v2])
      assert.equal((await get(`${root}/Items(1)/$count`)).status, 400);
  });

  it("a single-valued navigation has no $count", async () => {
    assert.equal((await get(`${s.v4}/Kids(1)/Parent/$count`)).status, 400);
  });

  it("a collection property's $count is how many it holds", async () => {
    const res = await get(`${s.v4}/Items(1)/Tags/$count`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "3");
  });

  it("a primitive or complex property has no $count", async () => {
    for (const root of [s.v4, s.v2]) {
      assert.equal((await get(`${root}/Items(1)/N/$count`)).status, 400);
      assert.equal((await get(`${root}/Items(1)/Addr/$count`)).status, 400);
    }
  });

  it("$value is a primitive's", async () => {
    assert.equal((await get(`${s.v4}/Items(1)/N/$value`)).body, "1");
    for (const root of [s.v4, s.v2])
      assert.equal((await get(`${root}/Items(1)/Addr/$value`)).status, 400);
    assert.equal((await get(`${s.v4}/Items(1)/Tags/$value`)).status, 400);
  });

  it("a collection's $count still counts", async () => {
    assert.equal((await get(`${s.v4}/Items/$count`)).body, "3");
    assert.equal((await get(`${s.v4}/Items(1)/Kids/$count`)).body, "1");
  });
});

describe("a system query option given twice", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  const OPTIONS = {
    v4: [
      "$orderby=ID",
      "$search=a",
      "$select=ID",
      "$expand=Kids",
      "$top=1",
      "$filter=ID eq 1",
      "$apply=identity",
      "$compute=N as M",
    ],
    v2: [
      "$orderby=ID",
      "$select=ID",
      "$expand=Kids",
      "$top=1",
      "$filter=ID eq 1",
      "search=a",
    ],
  };

  it("is a 400 naming it, never a 500 or the two glued together", async () => {
    for (const [root, options] of [
      [s.v4, OPTIONS.v4],
      [s.v2, OPTIONS.v2],
    ] as const)
      for (const option of options) {
        const name = option.split("=")[0];
        const res = await get(`${root}/Items?${option}&${option}`);
        assert.equal(res.status, 400, option);
        const error = res.body.error.message;
        assert.match(
          error.value ?? error,
          new RegExp(name.replace("$", "\\$")),
        );
      }
  });

  it("in a $batch too", async () => {
    const res = await batch(s.v4, [
      { method: "GET", url: "Items?$orderby=ID&$orderby=N" },
    ]);
    assert.equal(batchResponses(res.text)[0].status, 400);
  });
});

describe("$format", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  it("JSON, with or without parameters", async () => {
    for (const format of [
      "json",
      "application/json",
      "application/json;odata.metadata=minimal",
      "application/json%3Bodata.metadata%3Dminimal",
      "application/json;IEEE754Compatible=true",
    ])
      assert.equal(
        (await get(`${s.v4}/Items?$top=1&$format=${format}`)).status,
        200,
        format,
      );
  });

  it("anything else is still a 501", async () => {
    for (const format of ["xml", "atom", "application/jsonx", "text/json"])
      assert.equal(
        (await get(`${s.v4}/Items?$format=${format}`)).status,
        501,
        format,
      );
  });
});

describe("values that don't fit", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  let id = 100;
  const create = (fields: Record<string, unknown>, root = s.v4) =>
    send("POST", `${root}/Items`, { ID: id++, ...fields });

  it("a number written in hex or binary is no number", async () => {
    for (const value of ["0x10", "0b11", "0o7"]) {
      assert.equal((await create({ N: value })).status, 400, value);
      assert.equal((await create({ D: value })).status, 400, value);
    }
  });

  it("numbers as strings still read", async () => {
    assert.equal((await create({ N: "16" })).body.N, 16);
    assert.equal((await create({ N: " 16 " })).body.N, 16);
    assert.equal((await create({ D: "1e3" })).body.D, 1000);
    assert.equal((await create({ D: "INF" })).body.D, "INF");
  });

  it("an enum takes its members, by name or by value", async () => {
    assert.equal((await create({ Color: "Blue" })).body.Color, "Blue");
    assert.equal((await create({ Color: "2" })).body.Color, "Blue");
    assert.equal((await create({ Color: "Green" })).status, 400);
    assert.equal((await create({ Color: "Red,Blue" })).status, 400);
  });

  it("a flags enum takes several", async () => {
    const res = await create({ Perms: "Read,Admin" });
    assert.equal(res.body.Perms, "Read,Admin");
    assert.equal((await create({ Perms: "Read,Nope" })).status, 400);
  });

  it("a required field of a complex value is required", async () => {
    assert.equal((await create({ Addr: { Zip: "1" } })).status, 400);
    assert.equal((await create({ Addr: { City: "A" } })).status, 201);
    assert.equal((await create({ Addr: null })).status, 201);
  });

  it("at any depth, and in a collection", async () => {
    assert.equal((await create({ Site: { Addr: { Zip: "1" } } })).status, 400);
    assert.equal((await create({ Site: { Name: "x" } })).status, 201);
    assert.equal((await create({ Stops: [{ Zip: "1" }] })).status, 400);
    assert.equal((await create({ Stops: [{ City: "A" }] })).status, 201);
  });

  it("a PATCH too", async () => {
    const res = await send("PATCH", `${s.v4}/Items(1)`, {
      Addr: { Zip: "1" },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Addr\/City/);
  });
});

describe("properties named like what every object inherits", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  it("left out, they are null", async () => {
    const res = await send("POST", `${s.v4}/Odds`, { ID: 1 });
    assert.equal(res.status, 201);
    assert.equal(res.body.constructor, null);
    assert.equal(res.body.toString, null);
  });

  it("a PUT clears them", async () => {
    await send("POST", `${s.v4}/Odds`, { ID: 2, constructor: "a" });
    assert.equal((await send("PUT", `${s.v4}/Odds(2)`, {})).status, 204);
    assert.equal((await get(`${s.v4}/Odds(2)`)).body.constructor, null);
  });

  it("given, they are kept", async () => {
    const res = await send("POST", `${s.v4}/Odds`, {
      ID: 3,
      constructor: "c",
    });
    assert.equal(res.body.constructor, "c");
  });
});

describe("$filter on enums and times of day", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  const ids = async (filter: string) => {
    const res = await get(
      `${s.v4}/Items?$select=ID&$filter=${encodeURIComponent(filter)}`,
    );
    assert.equal(res.status, 200, `${filter}: ${JSON.stringify(res.body)}`);
    return res.body.value.map((r: { ID: number }) => r.ID);
  };

  it("hour, minute and second of an Edm.TimeOfDay", async () => {
    assert.deepEqual(await ids("hour(Tod) eq 12"), [1]);
    assert.deepEqual(await ids("minute(Tod) eq 34"), [1]);
    assert.deepEqual(await ids("second(Tod) eq 56"), [1]);
    assert.deepEqual(await ids("second(Tod) eq 3"), [2]);
  });

  it("an Edm.TimeOfDay filters by what a response shows of it", async () => {
    const shown = (await get(`${s.v4}/Items(2)`)).body.Tod;
    assert.equal(shown, "01:02:03");
    assert.deepEqual(await ids(`Tod eq ${shown}`), [2]);
    assert.deepEqual(await ids(`Tod ne ${shown} and Tod ne null`), [1]);
  });

  it("an enum literal, by namespace or alias", async () => {
    assert.deepEqual(await ids("Color eq Sh.Ns.Color'Red'"), [1]);
    assert.deepEqual(await ids("Color eq Sh.Color'Blue'"), [2]);
    assert.deepEqual(
      await ids("Color ne Sh.Color'Blue' and Color ne null"),
      [1],
    );
    assert.deepEqual(
      await ids("Color in (Sh.Color'Red',Sh.Color'Blue')"),
      [1, 2],
    );
  });

  it("an enum literal by the member's value", async () => {
    assert.deepEqual(await ids("Color eq Sh.Color'2'"), [2]);
    assert.deepEqual(await ids("Perms has Sh.Perm'2'"), [1]);
  });

  it("has", async () => {
    assert.deepEqual(await ids("Color has Sh.Color'Red'"), [1]);
    assert.deepEqual(await ids("Perms has Sh.Perm'Write'"), [1]);
    assert.deepEqual(await ids("Perms has Sh.Perm'Read'"), [1, 2]);
    assert.deepEqual(await ids("Perms has Sh.Perm'Read,Write'"), [1]);
    assert.deepEqual(await ids("not (Perms has Sh.Perm'Write')"), [2, 3]);
  });

  it("an enum literal in a key, which the server writes back", async () => {
    const created = await send("POST", `${s.v4}/ByColors`, { ID: "Red" });
    assert.equal(created.status, 201);
    const location = created.headers.get("location")!;
    assert.equal((await get(`${s.base}${location}`)).status, 200);
    assert.equal((await get(`${s.v4}/ByColors(Sh.Color'Red')`)).status, 200);
    assert.equal((await get(`${s.v4}/ByColors(Sh.Color'Blue')`)).status, 404);
  });

  it("a type or a member that doesn't exist is a 400, not an empty answer", async () => {
    for (const filter of [
      "Color eq No.Such'Red'",
      "Color eq Sh.Nope'Red'",
      "Color eq Sh.Color'Green'",
      "Color has Sh.Color'Green'",
      "Perms has Sh.Perm'Read,Nope'",
      "ID eq Sh.Item'1'",
      "NParent.Color'Red' eq 1",
    ]) {
      const res = await get(
        `${s.v4}/Items?$filter=${encodeURIComponent(filter)}`,
      );
      assert.equal(res.status, 400, filter);
    }
  });

  it("in $compute and $apply too", async () => {
    const computed = await get(
      `${s.v4}/Items?$compute=${encodeURIComponent("No.Such'Red' as C")}`,
    );
    assert.equal(computed.status, 400);
    const applied = await get(
      `${s.v4}/Items?$apply=${encodeURIComponent("filter(Color eq Sh.Color'Green')")}`,
    );
    assert.equal(applied.status, 400);
  });

  it("in a key: of its type, on a key that is one", async () => {
    await send("POST", `${s.v4}/ByColors`, { ID: "Blue" });
    for (const key of ["No.Such'Blue'", "Sh.Perm'Blue'", "Sh.Color'Green'"])
      assert.equal((await get(`${s.v4}/ByColors(${key})`)).status, 400, key);
    assert.equal((await get(`${s.v4}/Items(Sh.Color'1')`)).status, 400);
    assert.equal(
      (await get(`${s.v4}/ByColors(Sh.Ns.Color'Blue')`)).status,
      200,
    );
  });

  it("an unterminated one is a 400", async () => {
    const res = await get(`${s.v4}/Items?$filter=Color eq Sh.Color'Red`);
    assert.equal(res.status, 400);
  });

  it("V2 has none", async () => {
    const res = await get(`${s.v2}/Items?$filter=Color eq Sh.Color'Red'`);
    assert.equal(res.status, 400);
  });
});

describe("@odata.bind", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  it("null: on a create no link, on a PATCH none any more", async () => {
    const created = await send("POST", `${s.v4}/Kids`, {
      ID: 10,
      "Parent@odata.bind": null,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.ParentID, null);

    const linked = await send("POST", `${s.v4}/Kids`, {
      ID: 11,
      "Parent@odata.bind": "Items(1)",
    });
    assert.equal(linked.body.ParentID, 1);
    const cleared = await send("PATCH", `${s.v4}/Kids(11)`, {
      "Parent@odata.bind": null,
    });
    assert.equal(cleared.status, 204);
    assert.equal((await get(`${s.v4}/Kids(11)`)).body.ParentID, null);
  });

  it("null on a collection navigation is a 400", async () => {
    const res = await send("PATCH", `${s.v4}/Items(1)`, {
      "Kids@odata.bind": null,
    });
    assert.equal(res.status, 400);
  });

  it("$1, the entity a request before it in the changeset created", async () => {
    const res = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "Items",
          contentId: "1",
          body: { ID: 50 },
        },
        {
          method: "POST",
          url: "Kids",
          contentId: "2",
          body: { ID: 51, "Parent@odata.bind": "$1" },
        },
      ],
    ]);
    const [, kid] = batchResponses(res.text);
    assert.equal(kid.status, 201);
    assert.equal(kid.body.ParentID, 50);
  });

  it("in a list", async () => {
    const res = await batch(s.v4, [
      [
        { method: "POST", url: "Kids", contentId: "k", body: { ID: 60 } },
        {
          method: "POST",
          url: "Items",
          body: { ID: 61, "Kids@odata.bind": ["$k"] },
        },
      ],
    ]);
    assert.deepEqual(
      batchResponses(res.text).map((r) => r.status),
      [201, 201],
    );
    assert.equal((await get(`${s.v4}/Kids(60)`)).body.ParentID, 61);
  });

  it("a $id nothing answers to is a 400", async () => {
    const res = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "Kids",
          body: { ID: 70, "Parent@odata.bind": "$9" },
        },
      ],
    ]);
    assert.equal(batchResponses(res.text)[0].status, 400);
  });
});

describe("a schema's alias in a bound operation's name", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  it("calls it, as the namespace does", async () => {
    for (const name of ["Sh.Ns.Go", "Sh.Go"]) {
      const res = await send("POST", `${s.v4}/Items(1)/${name}`, {});
      assert.ok(res.status < 300, `${name}: ${res.status}`);
    }
  });
});

describe("a request nested past reason", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  const inBatch = async (url: string) => {
    const started = performance.now();
    const res = await batch(s.v4, [{ method: "GET", url }]);
    return {
      status: batchResponses(res.text)[0].status,
      took: performance.now() - started,
    };
  };

  it("$expand is a quick 400, not a stack overflow", async () => {
    let expand = "Kids";
    for (let i = 0; i < 20000; i++) expand = `Kids($expand=${expand})`;
    const { status, took } = await inBatch(`Items?$expand=${expand}`);
    assert.equal(status, 400);
    assert.ok(took < 1000, `${took}ms`);
  });

  it("$expand a few levels deep still answers", async () => {
    const res = await get(
      `${s.v4}/Items?$expand=Kids($expand=Parent($expand=Kids))`,
    );
    assert.equal(res.status, 200);
  });

  it("$search and $apply are a 400", async () => {
    const parens = 50000;
    assert.equal(
      (
        await inBatch(
          `Items?$search=${"(".repeat(parens)}a${")".repeat(parens)}`,
        )
      ).status,
      400,
    );
    assert.equal(
      (await inBatch(`Items?$search=${"NOT%20".repeat(parens)}a`)).status,
      400,
    );
    assert.equal(
      (
        await inBatch(
          `Items?$apply=${"concat(".repeat(20000)}identity${")".repeat(20000)}`,
        )
      ).status,
      400,
    );
  });

  it("$apply is a quick 400 too", async () => {
    const { status, took } = await inBatch(
      `Items?$apply=${"concat(".repeat(20000)}identity${")".repeat(20000)}`,
    );
    assert.equal(status, 400);
    assert.ok(took < 1000, `${took}ms`);
  });

  it("a long run of spaces in $expand doesn't hold the server", async () => {
    const spaces = "%20".repeat(100000);
    const { status, took } = await inBatch(`Items?$expand=Kids${spaces}x`);
    assert.equal(status, 400);
    assert.ok(took < 1000, `${took}ms`);
  });
});
