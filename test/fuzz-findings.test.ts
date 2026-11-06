import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  ORDER,
  type TestServer,
} from "./helpers.ts";

// What fuzzing the server found, each the smallest request that shows it

const fixture = (name: string) =>
  path.join(import.meta.dirname, "fixtures", name);

const BOOK = "b0000000-0000-4000-8000-000000000001";
const book = (active: boolean) => `Books(ID=${BOOK},IsActiveEntity=${active})`;

describe("a link is held to what a PATCH is, in a draft", () => {
  let s: TestServer;
  const authorOf = (active: boolean) =>
    (s.store.rows("Books") as Record<string, unknown>[]).find(
      (b) => b.ID === BOOK && b.IsActiveEntity === active,
    )?.author_ID;

  before(async () => {
    s = await start(fixture("DraftSrv"));
  });
  after(() => s.close());

  it("PUT and DELETE $ref on an active entity -> 400, it changes through its draft", async () => {
    const author = (s.store.rows("Authors") as { ID: string }[]).at(-1)!.ID;
    const before = authorOf(true);
    const put = await send("PUT", `${s.v4}/${book(true)}/author/$ref`, {
      "@odata.id": `Authors(${author})`,
    });
    assert.equal(put.status, 400);
    assert.match(put.body.error.message, /change its draft/);
    const del = await send("DELETE", `${s.v4}/${book(true)}/author/$ref`);
    assert.equal(del.status, 400);
    assert.equal(authorOf(true), before);
  });

  it("$ref on a draft sets the draft's link, and leaves the active entity's", async () => {
    const edit = await send(
      "POST",
      `${s.v4}/${book(true)}/CatalogService.draftEdit`,
      { PreserveChanges: false },
    );
    assert.equal(edit.status, 200);
    const author = (s.store.rows("Authors") as { ID: string }[]).at(-1)!.ID;
    const active = authorOf(true);
    const put = await send("PUT", `${s.v4}/${book(false)}/author/$ref`, {
      "@odata.id": `Authors(${author})`,
    });
    assert.equal(put.status, 204);
    assert.equal(authorOf(false), author);
    assert.equal(authorOf(true), active);
  });

  it("a draft's children can't be linked to or away from it", async () => {
    const created = await send("POST", `${s.v4}/Books`, {});
    assert.equal(created.status, 201);
    const url = `${s.v4}/Books(ID=${created.body.ID},IsActiveEntity=false)`;
    const kid = await send("POST", `${url}/chapters`, {});
    assert.equal(kid.status, 201);
    const key = `(ID=${kid.body.ID},IsActiveEntity=false)`;
    const away = await send("DELETE", `${url}/chapters${key}/$ref`);
    assert.equal(away.status, 400);
    assert.match(away.body.error.message, /stays in the draft/);
    const other = await send("POST", `${s.v4}/Books`, {});
    const added = await send(
      "POST",
      `${s.v4}/Books(ID=${other.body.ID},IsActiveEntity=false)/chapters/$ref`,
      { "@odata.id": `Chapters${key}` },
    );
    assert.equal(added.status, 400);
    assert.match(added.body.error.message, /stays in the draft/);
  });

  it("a draft child can't be linked out of its draft", async () => {
    const chapter = (
      s.store.rows("Chapters") as Record<string, unknown>[]
    ).find((c) => c.book_ID === BOOK && c.IsActiveEntity === false)!;
    const other = "New";
    const created = await send("POST", `${s.v4}/Books`, { title: other });
    assert.equal(created.status, 201);
    const target = `Books(ID=${created.body.ID},IsActiveEntity=false)`;
    const url = `${s.v4}/Chapters(ID=${String(chapter.ID)},IsActiveEntity=false)`;
    const ref = await send("PUT", `${url}/book/$ref`, {
      "@odata.id": target,
    });
    assert.equal(ref.status, 400);
    assert.match(ref.body.error.message, /stays in the draft/);
    const bind = await send("PATCH", url, { "book@odata.bind": target });
    assert.equal(bind.status, 400);
    assert.equal(chapter.book_ID, BOOK);
  });
});

describe("an update that says two things of a foreign key", () => {
  let s: TestServer;
  before(async () => {
    s = await start(fixture("Families"), { mockRows: 4 });
  });
  after(() => s.close());

  it("a foreign key that disagrees with a bind -> 400, nothing changes", async () => {
    const kid = (s.store.rows("Ks") as { ID: number; PID: number }[])[0];
    const was = kid.PID;
    const other = was === 1 ? 2 : 1;
    const r = await send("PATCH", `${s.v4}/Ks(${kid.ID})`, {
      PID: was,
      "Parent@odata.bind": `Ps(${other})`,
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "InvalidValue");
    assert.equal(kid.PID, was);
  });

  it("one that agrees -> the link moves", async () => {
    const kid = (s.store.rows("Ks") as { ID: number; PID: number }[])[0];
    const other = kid.PID === 1 ? 2 : 1;
    const r = await send("PATCH", `${s.v4}/Ks(${kid.ID})`, {
      PID: other,
      "Parent@odata.bind": `Ps(${other})`,
    });
    assert.equal(r.status, 204);
    assert.equal(kid.PID, other);
  });

  it("a foreign key with a bind that removes the link -> 400", async () => {
    const kid = (s.store.rows("Ks") as { ID: number; PID: number }[])[0];
    const r = await send("PATCH", `${s.v4}/Ks(${kid.ID})`, {
      PID: kid.PID,
      "Parent@odata.bind": null,
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /removes the link/);
  });
});

describe("a next link is one the server can read", () => {
  let s: TestServer;
  const order = { ...ORDER };
  const item = (n: number) => ({
    ItemPosition: `000${n}`,
    Material: "M",
    Description: "d",
    Quantity: "1.000",
    Unit: "EA",
    NetPrice: "1.00",
    Currency: "EUR",
  });

  before(async () => {
    s = await start(undefined, { pageSize: 1 });
  });
  after(() => s.close());

  for (const id of ["a/b", "50%", "é x"])
    it(`of a navigation under the key ${id}`, async () => {
      const created = await send("POST", `${s.v4}/PurchaseOrderSet`, {
        ...order,
        PurchaseOrderId: id,
      });
      assert.equal(created.status, 201);
      const url = `${s.base}${created.headers.get("location")}`;
      for (const n of [1, 2])
        assert.equal(
          (
            await send("POST", `${url}/Items`, {
              ...item(n),
              PurchaseOrderId: id,
            })
          ).status,
          201,
        );
      const nav = await get(`${url}/Items`);
      assert.equal(nav.status, 200);
      const next = await get(`${s.base}${nav.body["@odata.nextLink"]}`);
      assert.equal(next.status, 200);
      assert.equal(next.body.value[0].ItemPosition, "0002");

      const expanded = await get(`${url}?$expand=Items`);
      const link = expanded.body["Items@odata.nextLink"];
      assert.equal((await get(`${s.base}${link}`)).status, 200);
    });

  it("a custom option given twice is in it twice", async () => {
    const r = await get(`${s.v4}/PurchaseOrderSet?a=1&a=2`);
    assert.match(r.body["@odata.nextLink"], /[?&]a=1&a=2&/);
  });
});

describe("$ in a path may be escaped", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("%24metadata is $metadata", async () => {
    const r = await get(`${s.v4}/%24metadata`);
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get("content-type")), /xml/);
  });

  it("%24batch is $batch", async () => {
    const res = await fetch(`${s.v4}/%24batch`, {
      method: "POST",
      headers: { "content-type": "multipart/mixed; boundary=b" },
      body: "--b--\r\n",
    });
    assert.equal(res.status, 200);
  });

  it("%24 in a key is that key's $", async () => {
    const created = await send("POST", `${s.v4}/PurchaseOrderSet`, {
      ...ORDER,
      PurchaseOrderId: "a$b",
    });
    assert.equal(created.status, 201);
    const r = await get(`${s.v4}/PurchaseOrderSet('a%24b')`);
    assert.equal(r.body.PurchaseOrderId, "a$b");
    assert.equal(
      (await get(`${s.v4}/PurchaseOrderSet('a%2524b')`)).status,
      404,
    );
  });

  it("$batch by any other method -> 405, a $batch in a $batch stays what it was", async () => {
    assert.equal((await get(`${s.v4}/$batch`)).status, 405);
    assert.equal((await send("DELETE", `${s.v4}/$batch`)).status, 405);
    const res = await batch(s.v4, [
      { method: "POST", url: "$batch", body: {} },
    ]);
    assert.equal(batchResponses(res.text)[0].status, 404);
  });
});

describe("$format of what the server doesn't answer in", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  it("$metadata is XML", async () => {
    assert.equal((await get(`${s.v4}/$metadata?$format=json`)).status, 501);
    assert.equal((await get(`${s.v4}/$metadata?$format=xml`)).status, 200);
    assert.equal(
      (await get(`${s.v2}/$metadata?$format=application/xml`)).status,
      200,
    );
  });

  it("the service document is JSON", async () => {
    assert.equal((await get(`${s.v4}/?$format=xml`)).status, 501);
    assert.equal((await get(`${s.v2}/?$format=atom`)).status, 501);
    assert.equal((await get(`${s.v2}/?$format=json`)).status, 200);
  });
});

describe("$skiptoken is a collection's", () => {
  it("on one entity -> 400", async () => {
    const s = await start();
    try {
      const r = await get(
        `${s.v4}/PurchaseOrderSet('4500000001')?$skiptoken=1`,
      );
      assert.equal(r.status, 400);
    } finally {
      await s.close();
    }
  });
});

describe("length, indexof and substring count characters, as MaxLength does", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  for (const filter of [
    "length('😀') eq 1",
    "length('😀b') eq 2",
    "indexof('😀b','b') eq 1",
    "indexof('😀b','x') eq -1",
    "substring('😀b',1) eq 'b'",
    "substring('😀b',0,1) eq '😀'",
    "substring('a😀b',1,1) eq '😀'",
    "substring('😀b',-1) eq '😀b'",
    "substring('😀b',5) eq ''",
    "length('abc') eq 3",
    "substring('abc',1,1) eq 'b'",
  ])
    it(filter, async () => {
      const url = `${s.v4}/PurchaseOrderSet?$filter=${encodeURIComponent(filter)}`;
      assert.equal((await get(url)).body.value.length, 5);
    });
});
