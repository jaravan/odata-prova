import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  start,
  get,
  send,
  ITEM,
  PO_MODEL,
  type TestServer,
} from "./helpers.ts";

// Links between existing entities: Nav@odata.bind in a body, $ref (V4) and $links (V2), for
// each kind of link. Each test starts from the data files again.
const FIXTURES = path.join(import.meta.dirname, "fixtures");

// HiddenKeys: ann's photo is 2 (Mountain), ben has none; lines A and B are order 1's, C order
// 2's, on keys of their own
describe("links through a foreign key, on either side", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(path.join(FIXTURES, "HiddenKeys"));
  });
  afterEach(() => s.close());

  const photo = async (user: string) => {
    const r = await get(`${s.v4}/People('${user}')/Photo`);
    return r.status === 204 ? null : r.body.Name;
  };
  const lines = async (order: number) =>
    (await get(`${s.v4}/Orders(${order})/Lines`)).body.value.map(
      (l: { Code: string }) => l.Code,
    );

  it("@odata.bind on a create or an update, in any URL form", async () => {
    const created = await send("POST", `${s.v4}/People`, {
      UserName: "cy",
      "Photo@odata.bind": "Photos(1)",
    });
    assert.equal(created.status, 201);
    assert.equal(await photo("cy"), "Beach");

    for (const [url, name] of [
      ["/odata/v4/T/Photos(1)", "Beach"],
      [`${s.v4}/Photos(2)`, "Mountain"],
    ]) {
      const r = await send("PATCH", `${s.v4}/People('ann')`, {
        "Photo@odata.bind": url,
      });
      assert.equal(r.status, 204, url);
      assert.equal(await photo("ann"), name, url);
    }
  });

  it("a collection's: the target takes the link, from its old one", async () => {
    const created = await send("POST", `${s.v4}/Orders`, {
      Number: 3,
      "Lines@odata.bind": ["Lines('A')"],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await lines(3), ["A"]);
    assert.deepEqual(await lines(1), ["B"]);
  });

  it("a bad reference is a 400, and changes nothing", async () => {
    for (const body of [
      { "Photo@odata.bind": "Photos(9)" },
      { "Photo@odata.bind": "Orders(1)" },
      { "Photo@odata.bind": "/elsewhere/Photos(1)" },
      { "Photo@odata.bind": ["Photos(1)"] },
      { "Nope@odata.bind": "Photos(1)" },
      { Name: "Changed", "Photo@odata.bind": 1 },
    ]) {
      const r = await send("PATCH", `${s.v4}/People('ann')`, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, "InvalidReference", JSON.stringify(body));
    }
    assert.equal(await photo("ann"), "Mountain");
    assert.equal((await get(`${s.v4}/People('ann')`)).body.Name, "Ann");
  });

  it("$ref reads, sets and removes a single-valued navigation's link", async () => {
    const read = await get(`${s.v4}/People('ann')/Photo/$ref`);
    assert.deepEqual(read.body, {
      "@odata.context": "/odata/v4/T/$metadata#$ref",
      "@odata.id": "/odata/v4/T/Photos(2)",
    });
    assert.equal(
      (
        await send("PUT", `${s.v4}/People('ben')/Photo/$ref`, {
          "@odata.id": "Photos(1)",
        })
      ).status,
      204,
    );
    assert.equal(await photo("ben"), "Beach");
    assert.equal(
      (await send("DELETE", `${s.v4}/People('ben')/Photo/$ref`)).status,
      204,
    );
    assert.equal(await photo("ben"), null);
  });

  it("$ref reads a collection's links, adds one and removes one", async () => {
    const read = await get(`${s.v4}/Orders(1)/Lines/$ref`);
    assert.equal(
      read.body["@odata.context"],
      "/odata/v4/T/$metadata#Collection($ref)",
    );
    assert.deepEqual(read.body.value, [
      { "@odata.id": "/odata/v4/T/Lines('A')" },
      { "@odata.id": "/odata/v4/T/Lines('B')" },
    ]);
    await send("POST", `${s.v4}/Orders(2)/Lines/$ref`, {
      "@odata.id": "Lines('A')",
    });
    assert.deepEqual(await lines(2), ["A", "C"]);
    await send("DELETE", `${s.v4}/Orders(2)/Lines('A')/$ref`);
    await send("DELETE", `${s.v4}/Orders(2)/Lines/$ref?$id=Lines('C')`);
    assert.deepEqual(await lines(2), []);

    // Which link isn't said; PUT is for a single-valued one
    assert.equal(
      (await send("DELETE", `${s.v4}/Orders(1)/Lines/$ref`)).status,
      400,
    );
    assert.equal(
      (
        await send("PUT", `${s.v4}/Orders(1)/Lines/$ref`, {
          "@odata.id": "Lines('C')",
        })
      ).status,
      405,
    );
  });

  it("V2 $links, the same", async () => {
    const read = await get(`${s.v2}/People('ann')/$links/Photo`);
    assert.deepEqual(read.body, { d: { uri: "/odata/v2/T/Photos(2L)" } });
    await send("PUT", `${s.v2}/People('ben')/$links/Photo`, {
      uri: "Photos(1L)",
    });
    assert.equal(await photo("ben"), "Beach");
    await send("DELETE", `${s.v2}/Orders(1)/$links/Lines('A')`);
    assert.deepEqual(await lines(1), ["B"]);
  });
});

// ManyToMany: Compilers (10) has Ada (1) and Linus (2), Kernels (20) has Ada
describe("links through a link set", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(path.join(FIXTURES, "ManyToMany"));
  });
  afterEach(() => s.close());

  const courses = async (student: number) =>
    (await get(`${s.v4}/Students(${student})/Courses`)).body.value.map(
      (c: { CourseId: number }) => c.CourseId,
    );

  it("@odata.bind, $ref and $links add and remove pairs", async () => {
    const created = await send("POST", `${s.v4}/Students`, {
      StudentId: 5,
      "Courses@odata.bind": ["Courses(10)", "Courses(20)"],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await courses(5), [10, 20]);

    await send("POST", `${s.v4}/Students(2)/Courses/$ref`, {
      "@odata.id": "Courses(20)",
    });
    assert.deepEqual(await courses(2), [10, 20]);
    await send("DELETE", `${s.v4}/Students(1)/Courses(10)/$ref`);
    assert.deepEqual(await courses(1), [20]);
    // The courses themselves stay
    assert.equal((await get(`${s.v4}/Courses(10)`)).status, 200);

    const v2 = await get(`${s.v2}/Students(2)/$links/Courses`);
    assert.deepEqual(v2.body.d.results, [
      { uri: "/odata/v2/T/Courses(10)" },
      { uri: "/odata/v2/T/Courses(20)" },
    ]);
    await send("DELETE", `${s.v2}/Students(2)/$links/Courses(10)`);
    assert.deepEqual(await courses(2), [20]);
  });

  it("V2: a create with references links them", async () => {
    const created = await send("POST", `${s.v2}/Students`, {
      StudentId: 6,
      Courses: [{ __metadata: { uri: "Courses(10)" } }],
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await courses(6), [10]);
  });
});

describe("links that can't change", () => {
  it("a foreign key in the entity's key: set by a create, then fixed", async () => {
    const s = await start(PO_MODEL);
    try {
      // The item's key holds its order's: the bind fills it
      const created = await send("POST", `${s.v4}/PurchaseOrderItemSet`, {
        ...ITEM,
        ItemPosition: "0009",
        "PurchaseOrder@odata.bind": "PurchaseOrderSet('4500000002')",
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.PurchaseOrderId, "4500000002");
      const item = `${s.v4}/PurchaseOrderItemSet(PurchaseOrderId='4500000002',ItemPosition='0009')`;
      const moved = await send("PATCH", item, {
        "PurchaseOrder@odata.bind": "PurchaseOrderSet('4500000001')",
      });
      assert.equal(moved.status, 400);
      assert.match(moved.body.error.message, /key, which can't change/);
      const removed = await send("DELETE", `${item}/PurchaseOrder/$ref`);
      assert.equal(removed.status, 400);
      assert.match(removed.body.error.message, /required/);
    } finally {
      await s.close();
    }
  });

  it("an update whose link fails changes none of its properties either", async () => {
    const s = await start(PO_MODEL);
    try {
      const item = `${s.v4}/PurchaseOrderItemSet(PurchaseOrderId='4500000001',ItemPosition='0001')`;
      const before = (await get(item)).body.Description;
      const moved = await send("PATCH", item, {
        Description: "Changed",
        "PurchaseOrder@odata.bind": "PurchaseOrderSet('4500000002')",
      });
      assert.equal(moved.status, 400);
      assert.equal((await get(item)).body.Description, before);
    } finally {
      await s.close();
    }
  });

  it("containment: its targets are created through it", async () => {
    const s = await start(path.join(FIXTURES, "Containment"));
    try {
      const r = await send("PATCH", `${s.v4}/People('ben')`, {
        "Trips@odata.bind": ["People('ann')/Trips(1)"],
      });
      assert.equal(r.status, 400);
      assert.match(r.body.error.message, /contains its targets/);
      const ref = await send("POST", `${s.v4}/People('ben')/Trips/$ref`, {
        "@odata.id": "People('ann')/Trips(1)",
      });
      assert.equal(ref.status, 400);
    } finally {
      await s.close();
    }
  });
});
