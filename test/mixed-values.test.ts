// Enums by their values, defaults, and what a request asks that used to pass unnoticed.

import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../lib/app.ts";
import { parseMetadata } from "../lib/metadata.ts";
import {
  batchResponses,
  get,
  send,
  start,
  type TestServer,
} from "./helpers.ts";

const MODEL = path.join(import.meta.dirname, "fixtures", "Mixed");
const JSON_TYPE = { "content-type": "application/json" };

describe("enums", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    for (const row of [
      { ID: 1, Pm: "W,R", Col: "Red" },
      { ID: 2, Pm: "R,W", Col: "Blue" },
      { ID: 3, Pm: "R,R", Col: "Green" },
      { ID: 4, Pm: "3", Col: "4" },
    ])
      assert.equal(
        (await send("POST", `${s.v4}/Items`, { Name: "n", ...row })).status,
        201,
      );
  });
  after(() => s.close());

  const ids = async (filter: string) => {
    const { status, body } = await get(
      `${s.v4}/Items?$select=ID&$filter=${encodeURIComponent(filter)}`,
    );
    assert.equal(status, 200, filter);
    return body.value.map((r: { ID: number }) => r.ID);
  };

  it("a flags value is stored in one form, its members ordered by value", async () => {
    const { body } = await get(`${s.v4}/Items?$select=Pm`);
    assert.deepEqual(
      body.value.map((r: { Pm: string }) => r.Pm),
      ["R,W", "R,W", "R", "R,W"],
    );
  });

  for (const literal of ["R,W", "W,R", "3"])
    it(`Pm eq F.Perm'${literal}' finds every spelling`, async () => {
      assert.deepEqual(await ids(`Pm eq F.Perm'${literal}'`), [1, 2, 4]);
    });

  it("groups and counts them as one", async () => {
    const groups = await get(`${s.v4}/Items?$apply=groupby((Pm))`);
    assert.equal(groups.body.value.length, 2);
    const count = await get(
      `${s.v4}/Items?$apply=${encodeURIComponent("aggregate(Pm with countdistinct as N)")}`,
    );
    assert.equal(count.body.value[0].N, 2);
  });

  for (const [filter, expected] of [
    ["Col gt F.Color'Green'", [2, 4]],
    ["Col lt F.Color'Green'", [1]],
    ["Col ge F.Color'Green'", [2, 3, 4]],
    ["Col eq 2", [3]],
    ["Col gt 1", [2, 3, 4]],
    ["Col eq 8", []],
    ["Pm has 1", [1, 2, 3, 4]],
    ["Pm has 2", [1, 2, 4]],
    ["Pm has F.Perm'W'", [1, 2, 4]],
    ["Pm has F.Perm'X'", []],
    ["Col in (F.Color'Red',2)", [1, 3]],
  ] as const)
    it(`${filter}`, async () => {
      assert.deepEqual(await ids(filter), expected);
    });

  it("sort by value", async () => {
    const { body } = await get(`${s.v4}/Items?$orderby=Col,ID&$select=ID`);
    assert.deepEqual(
      body.value.map((r: { ID: number }) => r.ID),
      [1, 3, 2, 4],
    );
  });

  it("min and max by value", async () => {
    const { body } = await get(
      `${s.v4}/Items?$apply=${encodeURIComponent("aggregate(Col with max as A,Col with min as B)")}`,
    );
    assert.equal(body.value[0].A, "Blue");
    assert.equal(body.value[0].B, "Red");
  });

  it("a value no member makes up is refused", async () => {
    const res = await send("POST", `${s.v4}/Items`, {
      ID: 9,
      Name: "n",
      Pm: "8",
    });
    assert.equal(res.status, 400);
  });
});

describe("DefaultValue", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
  });
  afterEach(() => s.close());

  it("fills what a create leaves out", async () => {
    const { status, body } = await send("POST", `${s.v4}/Items`, { ID: 1 });
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.Name, "Open");
    assert.equal(body.Note, "hi");
  });

  it("leaves what a create sets, even when it sets null", async () => {
    const { body } = await send("POST", `${s.v4}/Items`, {
      ID: 1,
      Name: "mine",
      Note: null,
    });
    assert.equal(body.Name, "mine");
    assert.equal(body.Note, null);
    const required = await send("POST", `${s.v4}/Items`, { ID: 2, Name: null });
    assert.equal(required.status, 400);
  });

  it("a PUT resets to it", async () => {
    await send("POST", `${s.v4}/Items`, { ID: 1, Name: "mine", Note: "x" });
    const res = await send("PUT", `${s.v4}/Items(1)`, { Qty: 1 });
    assert.equal(res.status, 204);
    const { body } = await get(`${s.v4}/Items(1)`);
    assert.equal(body.Name, "Open");
    assert.equal(body.Note, "hi");
  });

  it("the generated V2 $metadata has it", async () => {
    const xml = await (await fetch(`${s.v2}/$metadata`)).text();
    assert.match(xml, /Name="Name"[^>]*DefaultValue="Open"/);
  });
});

describe("a write with no body", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Name: "kept", Note: "kept" });
  });
  after(() => s.close());

  for (const method of ["PUT", "PATCH"])
    it(`${method} is a 400, and wipes nothing`, async () => {
      const res = await fetch(`${s.v4}/Items(1)`, {
        method,
        headers: JSON_TYPE,
      });
      assert.equal(res.status, 400);
      assert.equal((await get(`${s.v4}/Items(1)`)).body.Note, "kept");
    });

  it("{} is a body: it changes nothing", async () => {
    assert.equal((await send("PATCH", `${s.v4}/Items(1)`, {})).status, 204);
  });
});

describe("paths in an expression", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Grps`, { ID: 5 });
    await send("POST", `${s.v4}/Items`, {
      ID: 1,
      Tags: ["a", "b"],
      Kids: [{ ID: 7 }, { ID: 8 }],
    });
    await send("POST", `${s.v4}/Items`, { ID: 2 });
  });
  after(() => s.close());

  const ids = async (query: string) => {
    const { status, body } = await get(
      `${s.v4}/Items?$select=ID&${encodeURI(query)}`,
    );
    assert.equal(status, 200, JSON.stringify(body));
    return body.value.map((r: { ID: number }) => r.ID);
  };

  for (const [query, expected] of [
    ["$filter=Kids/$count gt 0", [1]],
    ["$filter=Kids/$count eq 0", [2]],
    ["$filter=Kids/$count gt 1 and Tags/$count eq 2", [1]],
    ["$filter=Tags/$count gt 1", [1]],
    ["$orderby=Kids/$count desc", [1, 2]],
    ["$orderby=Kids/$count", [2, 1]],
    ["$filter=Group eq null", [1, 2]],
    ["$filter=Group ne null", []],
  ] as const)
    it(`${query}`, async () => {
      assert.deepEqual(await ids(query), expected);
    });

  it("$count of what isn't a collection is a 400", async () => {
    const { status } = await get(
      `${s.v4}/Items?$filter=${encodeURIComponent("Qty/$count gt 0")}`,
    );
    assert.equal(status, 400);
  });
});

describe("a field of a complex value", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Addr: { City: "A" } });
    await send("POST", `${s.v4}/Items`, { ID: 2 });
  });
  after(() => s.close());

  it("is served", async () => {
    const { status, body } = await get(`${s.v4}/Items(1)/Addr/City`);
    assert.equal(status, 200);
    assert.equal(body.value, "A");
    assert.match(body["@odata.context"], /Items\(1\)\/Addr\/City$/);
  });

  it("with its /$value", async () => {
    const res = await fetch(`${s.v4}/Items(1)/Addr/City/$value`);
    assert.equal(await res.text(), "A");
  });

  it("null, or in a complex value that's null, is a 204", async () => {
    assert.equal((await get(`${s.v4}/Items(1)/Addr/Zip`)).status, 204);
    assert.equal((await get(`${s.v4}/Items(2)/Addr/City`)).status, 204);
  });

  it("no such field is a 404 that says so", async () => {
    const { status, body } = await get(`${s.v4}/Items(1)/Addr/Nope`);
    assert.equal(status, 404);
    assert.match(body.error.message, /Nope/);
  });
});

describe("options that can't apply", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, {
      ID: 1,
      Tags: ["a", "b", "c"],
      At: "2025-01-01T00:00:00Z",
    });
  });
  after(() => s.close());

  for (const url of [
    "Items(1)?$filter=bad((",
    "Items(1)?$filter=ID eq 1",
    "Items(1)?$top=1",
    "Items(1)?$skip=1",
    "Items(1)?$orderby=ID",
    "Items(1)?$search=x",
    "Items(1)/Group?$filter=bad((",
    "Items(1)/Name?$top=1",
    "Items(1)/Tags?$filter=x",
    "Items(1)/Tags?$orderby=x",
    "Items/$count?$select=Nope",
  ])
    it(`${url} is a 400`, async () => {
      assert.equal((await get(`${s.v4}/${encodeURI(url)}`)).status, 400);
    });

  it("a collection property pages", async () => {
    const value = async (query: string) =>
      (await get(`${s.v4}/Items(1)/Tags?${query}`)).body.value;
    assert.deepEqual(await value("$top=1"), ["a"]);
    assert.deepEqual(await value("$skip=1"), ["b", "c"]);
    assert.deepEqual(await value("$skip=1&$top=1"), ["b"]);
  });

  it("what applies still does", async () => {
    assert.equal(
      (await get(`${s.v4}/Items(1)?$select=ID&$expand=Kids`)).status,
      200,
    );
    assert.equal((await get(`${s.v4}/Items/$count?$top=1`)).status, 200);
  });

  it("/$value writes a time as /Prop does", async () => {
    const value = await (await fetch(`${s.v4}/Items(1)/At/$value`)).text();
    assert.equal(value, (await get(`${s.v4}/Items(1)/At`)).body.value);
    assert.match(value, /\.0000000Z$/);
  });
});

describe("a navigation left empty in an update", () => {
  let s: TestServer;
  const status = async (method: string, id: number, body: unknown) =>
    (await send(method, `${s.v4}/Items(${id})`, body)).status;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Grps`, { ID: 1 });
    await send("POST", `${s.v4}/Items`, { ID: 1 });
    await send("POST", `${s.v4}/Items`, { ID: 2 });
    await send("POST", `${s.v4}/Kids`, { ID: 1, ItemID: 1 });
    await send("PUT", `${s.v4}/Items(1)/Group/$ref`, {
      "@odata.id": "Grps(1)",
    });
  });
  after(() => s.close());

  it("null or [] on a row that has them -> a 400, and nothing is written", async () => {
    for (const [method, body] of [
      ["PATCH", { Name: "x", Group: null }],
      ["PATCH", { Name: "x", Kids: [] }],
      ["PATCH", { Name: "x", Kids: null }],
      ["PUT", { Name: "x", Group: null }],
      ["PUT", { Name: "x", Kids: [] }],
    ] as const)
      assert.equal(await status(method, 1, body), 400, JSON.stringify(body));
    assert.equal((await get(`${s.v4}/Items(1)`)).body.Name, "Open");
    assert.equal((await get(`${s.v4}/Items(1)/Group`)).status, 200);
    assert.equal((await get(`${s.v4}/Items(1)/Kids/$count`)).body, "1");
  });

  it("says how to remove the link", async () => {
    const r = await send("PATCH", `${s.v4}/Items(1)`, { Group: null });
    assert.match(r.body.error.message, /Group: .*\$ref/);
    assert.equal(r.body.error.code, "InvalidValue");
  });

  it("null or [] on a row without related entities -> 204, nothing to change", async () => {
    for (const body of [{ Group: null }, { Kids: [] }, { Kids: null }])
      assert.equal(await status("PATCH", 2, body), 204, JSON.stringify(body));
  });

  it("a list for a single-valued navigation -> a 400, on any row", async () => {
    assert.equal(await status("PATCH", 1, { Group: [] }), 400);
    assert.equal(await status("PATCH", 2, { Group: [] }), 400);
    assert.equal(await status("PUT", 2, { Group: [] }), 400);
    const created = await send("POST", `${s.v4}/Items`, { ID: 3, Group: [] });
    assert.equal(created.status, 400);
    assert.match(created.body.error.message, /Group: expected an object/);
  });

  it("V2's forms behave as V4's, and a __deferred link is ignored", async () => {
    const v2 = (id: number, body: unknown) =>
      send("PUT", `${s.v2}/Items(${id})`, body);
    assert.equal((await v2(1, { Kids: { results: [] } })).status, 400);
    assert.equal((await v2(2, { Kids: { results: [] } })).status, 204);
    assert.equal((await v2(2, { Group: { results: [] } })).status, 400);
    const deferred = { __deferred: { uri: "x" } };
    assert.equal(
      (await v2(1, { Group: deferred, Kids: deferred })).status,
      204,
    );
  });
});

describe("If-None-Match", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "ETagSrv"));
  });
  after(() => s.close());

  const first = async () => (await get(`${s.v4}/Books`)).body.value[0];

  it("a read of what the client has is a 304", async () => {
    const book = await first();
    const url = `${s.v4}/Books(${book.ID})`;
    const tag = book["@odata.etag"];
    assert.equal((await get(url, { "if-none-match": tag })).status, 304);
    assert.equal((await get(url, { "if-none-match": "*" })).status, 304);
    assert.equal((await get(url, { "if-none-match": '"other"' })).status, 200);
  });

  it("a write is a 412, and changes nothing", async () => {
    const url = `${s.v4}/Books(${(await first()).ID})`;
    const none = { "if-none-match": "*" };
    assert.equal((await send("PATCH", url, {}, none)).status, 412);
    assert.equal((await send("DELETE", url, undefined, none)).status, 412);
  });
});

describe("$batch", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1 });
  });
  afterEach(() => s.close());

  const http = (lines: string, head = "") =>
    `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n${head}\r\n${lines}\r\n`;
  const send1 = async (body: string) => {
    const res = await fetch(`${s.v4}/$batch`, {
      method: "POST",
      headers: { "content-type": "multipart/mixed;boundary=b" },
      body,
    });
    assert.equal(res.status, 200);
    return batchResponses(await res.text());
  };
  const changeset = (...members: string[]) =>
    `--b\r\nContent-Type: multipart/mixed;boundary=c\r\n\r\n${members.map((m) => `--c\r\n${m}`).join("")}--c--\r\n--b--`;
  const post = (id: string, json: string) =>
    http(
      `POST Items HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${json}`,
      `Content-ID: ${id}\r\n`,
    );

  it("broken JSON in a part is a 400, and runs nothing", async () => {
    const [part] = await send1(
      `--b\r\n${http('POST Items HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"ID":')}--b--`,
    );
    assert.equal(part.status, 400);
    assert.equal((await get(`${s.v4}/Items/$count`)).body, "1");
  });

  it("an empty part is a 400, not the service document", async () => {
    const [part] = await send1(`--b\r\n${http("")}--b--`);
    assert.equal(part.status, 400);
  });

  it("a GET in a changeset fails it", async () => {
    const [part] = await send1(
      changeset(http("GET Items(1) HTTP/1.1\r\n\r\n", "Content-ID: 1\r\n")),
    );
    assert.equal(part.status, 400);
  });

  it("a repeated Content-ID fails the changeset, and undoes it", async () => {
    const [part] = await send1(
      changeset(post("1", '{"ID":2}'), post("1", '{"ID":3}')),
    );
    assert.equal(part.status, 400);
    assert.equal((await get(`${s.v4}/Items/$count`)).body, "1");
  });

  it("$1 can name a PATCH's entity", async () => {
    const patch = http(
      `PATCH Items(1) HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"Qty":1}`,
      "Content-ID: 1\r\n",
    );
    const again = http(
      `PATCH $1 HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"Note":"x"}`,
      "Content-ID: 2\r\n",
    );
    const parts = await send1(changeset(patch, again));
    assert.deepEqual(
      parts.map((p) => p.status),
      [204, 204],
    );
    assert.equal((await get(`${s.v4}/Items(1)`)).body.Note, "x");
  });

  it("a changeset with no boundary says so", async () => {
    const [part] = await send1(
      "--b\r\nContent-Type: multipart/mixed\r\n\r\nx\r\n--b--",
    );
    assert.equal(part.status, 400);
    assert.doesNotMatch(JSON.stringify(part.body), /undefined/);
  });
});

describe("assorted invalid input", () => {
  it("substring with a negative length is empty, as OData's has no swap", async () => {
    const s = await start(MODEL);
    try {
      await send("POST", `${s.v4}/Items`, { ID: 1 });
      const count = async (filter: string) =>
        (await get(`${s.v4}/Items?$filter=${encodeURIComponent(filter)}`)).body
          .value.length;
      assert.equal(await count("substring('abc',1,-1) eq ''"), 1);
      assert.equal(await count("substring('abc',1,1) eq 'b'"), 1);
    } finally {
      await s.close();
    }
  });

  it("an object where a value belongs is quoted, not [object Object]", async () => {
    const s = await start(MODEL);
    try {
      const res = await send("POST", `${s.v4}/Items`, {
        ID: 1,
        Pm: { a: 1 },
      });
      assert.equal(res.status, 400);
      assert.doesNotMatch(JSON.stringify(res.body), /object Object/);
    } finally {
      await s.close();
    }
  });

  it("a body nested past the stack is a 400 that says so", async () => {
    const s = await start(MODEL);
    try {
      const res = await fetch(`${s.v4}/Items`, {
        method: "POST",
        headers: JSON_TYPE,
        body: `${'{"a":'.repeat(200000)}1${"}".repeat(200000)}`,
      });
      assert.equal(res.status, 400);
      assert.doesNotMatch(await res.text(), /call stack/);
    } finally {
      await s.close();
    }
  });

  it("a TypeDefinition with no UnderlyingType is named", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"><TypeDefinition Name="T"/><EntityType Name="A"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int32" Nullable="false"/></EntityType><EntityContainer Name="C"><EntitySet Name="As" EntityType="N.A"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
    assert.throws(
      () => parseMetadata(xml),
      /metadata\.xml: TypeDefinition T has no UnderlyingType/,
    );
  });

  it("a CSV row with more cells than the header stops the start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cells-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.copyFileSync(
      path.join(MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    fs.writeFileSync(
      path.join(dir, "data", "Items.csv"),
      "ID,Name\n1,a,extra\n",
    );
    assert.throws(
      () => createApp({ modelDir: dir, log: () => {} }),
      (e: Error & { code?: string }) =>
        e.code === "ESEED" && /more cells than its header/.test(e.message),
    );
    fs.writeFileSync(path.join(dir, "data", "Items.csv"), "ID,Name\n1,a,\n");
    assert.doesNotThrow(() => createApp({ modelDir: dir, log: () => {} }));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("a body that isn't an object", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Name: "kept" });
  });
  afterEach(() => s.close());

  for (const method of ["PUT", "PATCH"])
    for (const root of ["v4", "v2"] as const)
      it(`${method} [] is a 400 in ${root}, and wipes nothing`, async () => {
        assert.equal(
          (await send(method, `${s[root]}/Items(1)`, [])).status,
          400,
        );
        assert.equal((await get(`${s.v4}/Items(1)`)).body.Name, "kept");
      });

  it("POST [] too", async () => {
    assert.equal((await send("POST", `${s.v4}/Items`, [])).status, 400);
  });
});

describe("a V2 PUT", () => {
  it("keeps the collection properties V2 doesn't serve", async () => {
    const s = await start(MODEL);
    try {
      await send("POST", `${s.v4}/Items`, {
        ID: 1,
        Tags: ["a"],
        Addrs: [{ City: "A" }],
      });
      assert.equal(
        (await send("PUT", `${s.v2}/Items(1)`, { Qty: 2 })).status,
        204,
      );
      const { body } = await get(`${s.v4}/Items(1)`);
      assert.equal(body.Qty, 2);
      assert.deepEqual(body.Tags, ["a"]);
      assert.equal(body.Addrs.length, 1);
    } finally {
      await s.close();
    }
  });
});

describe("enums, further", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    for (const row of [
      { ID: 1, Au: "One", Bg: "Top", Cm: "R,W", Cols: ["Blue", "Red"] },
      { ID: 2, Au: "Two", Bg: "Hi", Cm: "RW", Perms: ["R,W"] },
      { ID: 3, Au: "Six", Bg: "Lo,Hi", Cm: "3", Cols: ["Red"] },
      { ID: 4, Au: "Five", Bg: "4294967297", Cm: "RW,X", Perms: ["W"] },
    ])
      assert.equal((await send("POST", `${s.v4}/Items`, row)).status, 201);
  });
  after(() => s.close());

  const ids = async (filter: string) => {
    const { status, body } = await get(
      `${s.v4}/Items?$select=ID&$filter=${encodeURIComponent(filter)}`,
    );
    assert.equal(status, 200, filter);
    return body.value.map((r: { ID: number }) => r.ID);
  };

  for (const [filter, expected] of [
    ["Au eq F.Auto'Two'", [2]],
    ["Au eq 0", [1]],
    ["Au eq 1", [2]],
    ["Au eq 6", [3]],
    ["Au gt F.Auto'Two'", [3, 4]],
    ["Bg has F.Big'Hi'", [2, 3, 4]],
    ["Bg has F.Big'Top'", [1]],
    ["Bg eq F.Big'4294967297'", [3, 4]],
    ["Cols/any(c:c gt F.Color'Red')", [1]],
    ["Cols/any(c:c eq 4)", [1]],
    ["Perms/any(p:p has 1)", [2]],
    ["Cm eq F.Combo'RW'", [1, 2, 3]],
    ["Cm eq F.Combo'R,W'", [1, 2, 3]],
    ["Cm has F.Combo'R'", [1, 2, 3, 4]],
  ] as const)
    it(`${filter}`, async () => {
      assert.deepEqual(await ids(filter), expected);
    });

  it("a value with a combined member groups as one", async () => {
    const { body } = await get(
      `${s.v4}/Items?$filter=ID lt 4&$apply=${encodeURIComponent("groupby((Cm))")}`.replace(
        "$filter=ID lt 4&",
        "",
      ),
    );
    assert.equal(body.value.length, 2);
  });

  it("max by value on 64 bits", async () => {
    const { body } = await get(
      `${s.v4}/Items?$apply=${encodeURIComponent("aggregate(Bg with max as M,Au with max as A)")}`,
    );
    assert.equal(body.value[0].M, "Top");
    assert.equal(body.value[0].A, "Six");
  });

  it("sorted by 64 bits", async () => {
    const { body } = await get(
      `${s.v4}/Items?$orderby=${encodeURIComponent("Bg desc,ID")}&$select=ID&$top=1`,
    );
    assert.equal(body.value[0].ID, 1);
  });
});

describe("collection properties", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, {
      ID: 1,
      Tags: ["a", "b", "c"],
      Addrs: [{ City: "A" }],
    });
  });
  after(() => s.close());

  it("/$count counts them all, whatever pages the list", async () => {
    for (const query of ["$top=1", "$skip=1"]) {
      const res = await fetch(`${s.v4}/Items(1)/Tags/$count?${query}`);
      assert.equal(await res.text(), "3", query);
    }
  });

  it("a path through one is a 400, not null", async () => {
    const { status, body } = await get(`${s.v4}/Items(1)/Addrs/City`);
    assert.equal(status, 400);
    assert.match(body.error.message, /Addrs/);
  });
});

describe("query options on a request that can't take them", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Tags: ["a"] });
  });
  afterEach(() => s.close());

  for (const url of [
    "Items(1)/Tags?$count=true",
    "Items(1)/Tags?$select=Nope",
    "Items(1)?$count=true",
    "Items(1)/Name?$expand=Nope",
    "Items(1)/Name?$select=Nope",
  ])
    it(`GET ${url} is a 400`, async () => {
      assert.equal((await get(`${s.v4}/${url}`)).status, 400);
    });

  it("POST with a read's options is a 400, and creates nothing", async () => {
    const res = await send(
      "POST",
      `${s.v4}/Items?$filter=${encodeURIComponent("bad((")}`,
      { ID: 2 },
    );
    assert.equal(res.status, 400);
    assert.equal((await get(`${s.v4}/Items(2)`)).status, 404);
  });

  it("POST with $select still works", async () => {
    const res = await send("POST", `${s.v4}/Items?$select=ID`, { ID: 3 });
    assert.equal(res.status, 201);
  });

  it("DELETE with $select is a 400, and deletes nothing", async () => {
    const res = await send("DELETE", `${s.v4}/Items(1)?$select=Nope`);
    assert.equal(res.status, 400);
    assert.equal((await get(`${s.v4}/Items(1)`)).status, 200);
  });
});

describe("a $filter that isn't a valid condition", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Qty: 1, Sh: "Red" });
  });
  after(() => s.close());

  const status = async (filter: string) =>
    (await get(`${s.v4}/Items?$filter=${encodeURIComponent(filter)}`)).status;

  for (const filter of [
    "Qty",
    "Name",
    "5",
    "'x'",
    "Group",
    "Group eq 5",
    "Group gt null",
    "Qty has 1",
    "Sh eq F.Color'Red'",
    "round(Addr) eq 1",
    "length(Addr) eq 1",
    "Addr eq 'x'",
    "Addr add 1 eq 1",
  ])
    it(`${filter} is a 400`, async () => {
      assert.equal(await status(filter), 400);
      const { body } = await get(
        `${s.v4}/Items?$filter=${encodeURIComponent(filter)}`,
      );
      assert.doesNotMatch(JSON.stringify(body), /object Object/);
    });

  for (const filter of [
    "Qty eq 1",
    "Sh eq F.Shade'Red'",
    "Group eq null",
    "contains(Name,'x')",
    "not contains(Name,'x')",
    "Addr eq null",
    "null",
    "true",
  ])
    it(`${filter} is fine`, async () => {
      assert.equal(await status(filter), 200);
    });
});

describe("a DefaultValue that isn't a value", () => {
  const schema = (property: string) =>
    `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"><EntityType Name="A"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int32" Nullable="false"/>${property}</EntityType><EntityContainer Name="C"><EntitySet Name="As" EntityType="N.A"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;

  for (const property of [
    `<Property Name="D" Type="Edm.Int32" DefaultValue="abc"/>`,
    `<Property Name="D" Type="Edm.Int32" DefaultValue="null"/>`,
    `<Property Name="D" Type="Edm.Decimal" DefaultValue="0M"/>`,
    `<Property Name="D" Type="Edm.Guid" DefaultValue="guid'00000000-0000-0000-0000-000000000000'"/>`,
    `<Property Name="D" Type="Edm.String" MaxLength="2" DefaultValue="long"/>`,
    `<Property Name="D" Type="Edm.Boolean" DefaultValue="maybe"/>`,
    `<Property Name="D" Type="Collection(Edm.String)" DefaultValue="x"/>`,
  ])
    it(`${property} -> a warning naming it, and it's left out`, async () => {
      const model = parseMetadata(schema(property));
      assert.ok(
        model.warnings.some((w) => /DefaultValue ignored: A\.D: /.test(w)),
        model.warnings.join("\n"),
      );
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "default-"));
      fs.writeFileSync(path.join(dir, "metadata.xml"), schema(property));
      const s = await start(dir);
      try {
        const r = await send("POST", `${s.v4}/As`, { ID: 1 });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.doesNotMatch(
          (await get(`${s.v2}/$metadata`)).body,
          /DefaultValue/,
        );
      } finally {
        await s.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

  it("one that fits -> no warning", () => {
    const model = parseMetadata(
      schema(`<Property Name="D" Type="Edm.Int32" DefaultValue="5"/>`),
    );
    assert.deepEqual(model.warnings, []);
    assert.equal(model.entityTypes["N.A"].properties.D.defaultValue, "5");
  });
});

describe("a 304", () => {
  it("has the ETag, and a reason in a $batch", async () => {
    const s = await start(
      path.join(import.meta.dirname, "fixtures", "ETagSrv"),
    );
    try {
      const book = (await get(`${s.v4}/Books`)).body.value[0];
      const url = `${s.v4}/Books(${book.ID})`;
      const res = await get(url, { "if-none-match": "*" });
      assert.equal(res.status, 304);
      assert.equal(res.headers.get("etag"), book["@odata.etag"]);
      const text = await (
        await fetch(`${s.v4}/$batch`, {
          method: "POST",
          headers: { "content-type": "multipart/mixed;boundary=b" },
          body: `--b\r\nContent-Type: application/http\r\n\r\nGET Books(${book.ID}) HTTP/1.1\r\nIf-None-Match: *\r\n\r\n\r\n--b--`,
        })
      ).text();
      assert.match(text, /HTTP\/1\.1 304 Not Modified/);
    } finally {
      await s.close();
    }
  });
});

describe("a value the server can't hold", () => {
  it("doesn't stop a row being PUT back as it was read", async () => {
    const s = await start(MODEL);
    try {
      await send("POST", `${s.v4}/Items`, { ID: 1 });
      const { body } = await get(`${s.v4}/Items(1)`);
      assert.equal(body.Spot, null);
      const { "@odata.context": _, ...row } = body;
      assert.equal((await send("PUT", `${s.v4}/Items(1)`, row)).status, 204);
    } finally {
      await s.close();
    }
  });
});

describe("a body that isn't an object, in a $batch", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Name: "mine", Qty: 5 });
  });
  afterEach(() => s.close());

  const part = async (
    root: string,
    method: string,
    url: string,
    json: string,
  ) => {
    const res = await fetch(`${root}/$batch`, {
      method: "POST",
      headers: { "content-type": "multipart/mixed;boundary=b" },
      body: `--b\r\nContent-Type: multipart/mixed;boundary=c\r\n\r\n--c\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: 1\r\n\r\n${method} ${url} HTTP/1.1\r\nContent-Type: application/json\r\n\r\n${json}\r\n--c--\r\n--b--`,
    });
    return batchResponses(await res.text())[0];
  };

  for (const [version, method] of [
    ["v4", "PUT"],
    ["v4", "PATCH"],
    ["v2", "PUT"],
    ["v2", "MERGE"],
  ] as const)
    for (const json of ["[]", "12345678901234567890123"])
      it(`${version} ${method} ${json} is a 400, and the row stays`, async () => {
        const res = await part(s[version], method, "Items(1)", json);
        assert.equal(res.status, 400);
        assert.match(JSON.stringify(res.body), /JSON object/);
        const { body } = await get(`${s.v4}/Items(1)`);
        assert.equal(body.Name, "mine");
        assert.equal(body.Qty, 5);
      });

  it("POST [] says the body is wrong, not that a key is missing", async () => {
    const res = await part(s.v4, "POST", "Items", "[]");
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /JSON object/);
  });

  it("an object still resolves its references", async () => {
    await send("POST", `${s.v4}/Kids`, { ID: 7 });
    const res = await part(
      s.v4,
      "PATCH",
      "Kids(7)",
      '{"Item@odata.bind":"Items(1)"}',
    );
    assert.equal(res.status, 204);
    assert.equal((await get(`${s.v4}/Kids(7)`)).body.ItemID, 1);
  });
});

describe("an invalid $filter or $orderby, whatever rows there are", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, {
      ID: 1,
      Name: "a",
      Qty: 1,
      Cm: "R,W",
      Col: "Red",
      Sh: "Red",
      Tags: ["secret"],
      Cols: ["Red"],
      Bools: [true],
      Addrs: [{ City: "x" }],
    });
    await send("POST", `${s.v4}/Kids`, { ID: 1, ItemID: 1 });
  });
  after(() => s.close());

  const filter = (text: string) =>
    get(`${s.v4}/Items?$select=ID&$filter=${encodeURIComponent(text)}`);

  for (const text of [
    "not Qty",
    "not Name",
    "Qty and true",
    "true and Qty",
    "true or Name",
    "not (true and Name)",
    "not Group",
    "Addr or true",
    "Kids/any(k:k/ID)",
    "Kids/all(k:k/ItemID)",
    "Addrs/any(a:a/City)",
    "Addrs/any(a:a)",
    "Tags/any(t:t)",
    "Cols/any(c:c)",
    "Kids/any(k:k)",
  ])
    it(`${text} -> 400: not a boolean condition`, async () => {
      const res = await filter(text);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error.message, /condition/);
    });

  for (const text of [
    "not (Qty gt 0)",
    "true and not (Name eq 'z')",
    "null or Qty eq 1",
    "Bools/any(b:b)",
    "Bools/any(b:not b)",
    "Kids/any(k:k/ID gt 0)",
    "Kids/any()",
    "Addrs/any(a:a/City eq 'x')",
    "Addrs/any(a:a/City ne null and contains(a/City,'x'))",
    "Tags/any(t:t eq 'secret')",
    "Tags/any(t:contains(t,'e'))",
    "Kids/any(k:k/Item/Kids/any(j:j/ID eq k/ID))",
    "Addr eq null",
    "Group eq null",
    "Tags/$count gt 0",
  ])
    it(`${text} still is one`, async () => {
      const res = await filter(text);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.value.length <= 1);
    });

  it("a field no complex item has is a 400", async () => {
    assert.equal((await filter("Addrs/any(a:a/Nope eq 'x')")).status, 400);
  });

  for (const text of [
    "Tags eq 'a'",
    "Tags ne 'a'",
    "Tags has 'a'",
    "Tags in (null)",
    "Tags in ('a')",
    "Qty in (Tags)",
    "Tags gt null",
    "Addrs eq 'a'",
    "Cols has F.Color'Red'",
    "Addrs/any(a:a eq 'x')",
  ])
    it(`${text} is a 400 that shows no row`, async () => {
      for (const res of [
        await filter(text),
        await get(
          `${s.v4}/Items?$filter=${encodeURIComponent(`${text} and ID eq 99`)}`,
        ),
      ]) {
        assert.equal(res.status, 400, JSON.stringify(res.body));
        assert.doesNotMatch(res.body.error.message, /secret/);
      }
    });

  it("on an empty set too", async () => {
    const empty = await start(MODEL);
    try {
      const res = await get(`${empty.v4}/Items?$filter=Tags eq 'a'`);
      assert.equal(res.status, 400);
    } finally {
      await empty.close();
    }
  });

  for (const text of [
    "Cols/any(c:c eq F.Shade'Red')",
    "Qty eq F.Color'Red'",
    "Name eq F.Color'Red'",
    "Tags/any(t:t eq F.Color'Red')",
    "Col eq Sh",
    "Sh ne Col",
    "Col in (Sh)",
    "Cols/any(c:c eq Sh)",
  ])
    it(`${text} -> 400: an enum literal against another type`, async () => {
      assert.equal((await filter(text)).status, 400);
    });

  for (const [text, found] of [
    ["Cols/any(c:c eq F.Color'Red')", 1],
    ["Col eq F.Color'Red'", 1],
    ["Col eq 1", 1],
    ["Cols/any(c:c eq Col)", 1],
    ["F.Color'Red' eq Col", 1],
    ["F.Color'Red' eq F.Color'Red'", 1],
    ["F.Color'Red' eq F.Color'Blue'", 0],
    ["F.Combo'R,W' has F.Combo'R'", 1],
    ["F.Combo'R,W' has F.Combo'X'", 0],
    ["F.Combo'RW' has F.Combo'W'", 1],
    ["F.Perm'R,W' has F.Perm'R'", 1],
    ["Cm has F.Combo'R'", 1],
    ["Cm has F.Combo'X'", 0],
  ] as const)
    it(`${text} finds ${found}`, async () => {
      const res = await filter(text);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.value.length, found);
    });

  for (const path of ["Tags", "Addrs", "Cols", "Perms", "Bools"])
    it(`$orderby=${path} is a 400`, async () => {
      const res = await get(`${s.v4}/Items?$orderby=${path}`);
      assert.equal(res.status, 400);
      assert.match(res.body.error.message, /has no value/);
    });
});

describe("a number too long for any enum", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    s.store.audit = false;
    for (let ID = 1; ID <= 2000; ID++)
      s.store.insert("Items", { ID, Name: "n", Pm: "R", Col: "Red" });
  });
  after(() => s.close());

  const digits = "1".repeat(300_000);
  const inBatch = async (filter: string) => {
    const url = `Items?$top=1&$select=ID&$filter=${encodeURIComponent(filter)}`;
    const started = performance.now();
    const res = await fetch(`${s.v4}/$batch`, {
      method: "POST",
      headers: { "content-type": "multipart/mixed;boundary=b" },
      body: `--b\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nGET ${url} HTTP/1.1\r\n\r\n\r\n--b--`,
    });
    const [part] = batchResponses(await res.text());
    return { status: part.status, ms: performance.now() - started };
  };

  for (const filter of [
    `Pm has ${digits}`,
    `Pm has '${digits}'`,
    `Pm eq ${digits}`,
    `Col eq '${digits}'`,
    `Pm has '${Array(100_000).fill("1").join(",")}'`,
  ])
    it(`${filter.slice(0, 12)}… is a quick 400`, async () => {
      const { status, ms } = await inBatch(filter);
      assert.equal(status, 400);
      assert.ok(ms < 2000, `took ${ms}ms`);
    });

  // The work limit counts its length for each row, but reading it costs far more: it was read
  // again for every row until the limit stopped it, which took 0.6s here and over 2s on CI
  for (const op of ["has", "eq"])
    it(`a long list of flags after ${op} is read once, not for each row`, async () => {
      const list = Array(100_000).fill("1").join(",");
      const { status, ms } = await inBatch(`Pm ${op} '${list}'`);
      assert.equal(status, 400);
      assert.ok(ms < 300, `took ${ms}ms`);
    });

  it("in a lambda, on rows that have items", async () => {
    for (const row of s.store.rows("Items")) row.Perms = ["R"];
    for (const filter of [
      `Perms/any(p:p has ${digits})`,
      `Perms/any(p:p has '${digits}')`,
    ]) {
      const { status, ms } = await inBatch(filter);
      assert.equal(status, 400, filter.slice(0, 20));
      assert.ok(ms < 2000, `took ${ms}ms`);
    }
  });

  it("the widest number there is still works", async () => {
    assert.equal((await inBatch("Pm has 18446744073709551615")).status, 200);
    assert.equal((await inBatch("Pm eq -9223372036854775808")).status, 200);
  });
});

describe("a member's Value", () => {
  const model = (value: string) =>
    `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="F" xmlns="http://docs.oasis-open.org/odata/ns/edm"><EnumType Name="Color"><Member Name="Red" Value="${value}"/></EnumType><EntityContainer Name="C"/></Schema></edmx:DataServices></edmx:Edmx>`;

  for (const value of ["abc", "1.5", "", "1e3"])
    it(`"${value}" stops the start, and says where`, () => {
      assert.throws(
        () => parseMetadata(model(value)),
        /metadata\.xml: F\.Color\.Red: Value "[^"]*" is not a whole number/,
      );
    });

  for (const value of ["0", "-3", "4611686018427387904"])
    it(`${value} is a valid Value`, () => {
      assert.equal(
        parseMetadata(model(value)).enumTypes["F.Color"].members[0].value,
        value,
      );
    });
});

describe("enum members that share a value", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    for (const [ID, Tw] of [
      [1, "A"],
      [2, "B"],
      [3, "C"],
    ])
      await send("POST", `${s.v4}/Items`, { ID, Tw });
  });
  after(() => s.close());

  it("form one group, as eq treats them as equal", async () => {
    const { status, body } = await get(
      `${s.v4}/Items?$apply=groupby((Tw),aggregate($count as C))&$orderby=C`,
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(
      body.value.map((r: { C: number }) => r.C),
      [1, 2],
    );
  });
});

describe("read options on a write", () => {
  let s: TestServer;
  beforeEach(async () => {
    s = await start(MODEL);
    await send("POST", `${s.v4}/Items`, { ID: 1, Name: "mine", Qty: 5 });
  });
  afterEach(() => s.close());

  for (const method of ["PUT", "PATCH"])
    for (const option of [
      "$select=Nope",
      "$expand=Nope",
      "$expand=Kids($select=Nope)",
    ])
      it(`${method} ?${option} is a 400, and writes nothing`, async () => {
        const res = await send(method, `${s.v4}/Items(1)?${option}`, {
          Qty: 9,
        });
        assert.equal(res.status, 400);
        assert.equal((await get(`${s.v4}/Items(1)`)).body.Qty, 5);
      });

  it("POST ?$select=Nope too, when it wants no body back", async () => {
    const res = await fetch(`${s.v4}/Items?$select=Nope`, {
      method: "POST",
      headers: { ...JSON_TYPE, prefer: "return=minimal" },
      body: JSON.stringify({ ID: 2 }),
    });
    assert.equal(res.status, 400);
    assert.equal((await get(`${s.v4}/Items(2)`)).status, 404);
  });

  it("one that names what's there still works", async () => {
    const res = await fetch(`${s.v4}/Items(1)?$select=Qty`, {
      method: "PATCH",
      headers: { ...JSON_TYPE, prefer: "return=representation" },
      body: JSON.stringify({ Qty: 9 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.Qty, 9);
    assert.equal(body.Name, undefined);
  });
});

describe("a path into a complex value", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
    for (const row of [
      {
        ID: 1,
        Addr: { City: "Athens" },
        Place: {
          Addr: { City: "Zurich" },
          Col: "Red",
          Cols: ["Red", "Blue"],
          Stops: [{ Addr: { City: "Rome" } }],
        },
      },
      {
        ID: 2,
        Addr: { City: "Berlin" },
        Place: { Addr: { City: "Oslo" }, Col: "Blue", Cols: [], Stops: [] },
      },
      { ID: 3, Addr: { Zip: "1" } },
      { ID: 4 },
    ])
      assert.equal((await send("POST", `${s.v4}/Items`, row)).status, 201);
    await send("POST", `${s.v4}/Kids`, { ID: 1, ItemID: 1 });
  });
  after(() => s.close());

  const ids = async (query: string, root = s.v4) => {
    const { status, body } = await get(`${root}/Items?${query}`, {
      accept: "application/json",
    });
    assert.equal(status, 200, JSON.stringify(body));
    return (body.value ?? body.d.results ?? body.d).map(
      (r: { ID: number }) => r.ID,
    );
  };
  const filter = (text: string, root = s.v4) =>
    ids(`$select=ID&$filter=${encodeURIComponent(text)}`, root);

  for (const [text, found] of [
    ["Addr/City eq 'Athens'", [1]],
    ["$it/Addr/City eq 'Athens'", [1]],
    ["Addr/City ne 'Athens'", [2, 3, 4]],
    ["Addr/City eq null", [3, 4]],
    ["Addr/City ne null", [1, 2]],
    ["startswith(Addr/City,'Ber')", [2]],
    ["length(Addr/City) eq 6", [1, 2]],
    ["Addr/City in ('Athens','Berlin')", [1, 2]],
    ["Place/Addr/City eq 'Oslo'", [2]],
    ["Place/Addr/City eq null", [3, 4]],
    ["Place/Col eq F.Color'Blue'", [2]],
    ["Place/Col eq 1", [1]],
    ["Place/Cols/any(c:c eq F.Color'Blue')", [1]],
    ["Place/Cols/$count eq 2", [1]],
    ["Place/Addr ne null", [1, 2]],
    ["Addr eq null", [4]],
    ["Addrs/$count eq 0", [1, 2, 3, 4]],
    ["Place/Stops/any(p:p/Addr/City eq 'Rome')", [1]],
    ["Kids/any(k:k/Item/Addr/City eq 'Athens')", [1]],
  ] as const)
    it(`$filter=${text}`, async () => {
      assert.deepEqual(await filter(text), found);
    });

  for (const text of [
    "Addr/Nope eq 'x'",
    "Addr/City/Nope eq 'x'",
    "Place/Addr/Nope eq 'x'",
    "Addrs/City eq 'x'",
    "Addr/City",
    "Place/Addr eq 'x'",
    "Place/Cols eq 'x'",
    "Place/Col eq F.Shade'Red'",
    "Addr/City has 'x'",
    "Name/City eq 'x'",
    "Place/Stops/any(p:p/Addr/Nope eq 'x')",
    "Place/Stops/any(p:p/Addr/City)",
  ])
    it(`$filter=${text} is a 400 with no row to read`, async () => {
      const res = await get(
        `${s.v4}/Items?$filter=${encodeURIComponent(text)}`,
      );
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.doesNotMatch(res.body.error.message, /Athens|Zurich/);
    });

  it("$orderby sorts by it, nulls first, and either way", async () => {
    assert.deepEqual(
      await ids("$select=ID&$orderby=Addr/City,ID"),
      [3, 4, 1, 2],
    );
    assert.deepEqual(
      await ids("$select=ID&$orderby=Addr/City desc,ID"),
      [2, 1, 3, 4],
    );
    assert.deepEqual(
      await ids("$select=ID&$orderby=Place/Addr/City,ID"),
      [3, 4, 2, 1],
    );
  });

  it("$orderby sorts an enum in one by its number", async () => {
    assert.deepEqual(
      await ids("$select=ID&$orderby=Place/Col desc,ID"),
      [2, 1, 3, 4],
    );
  });

  for (const path of ["Place/Addr", "Place/Cols", "Addr/Nope", "Addrs/City"])
    it(`$orderby=${path} is a 400`, async () => {
      assert.equal((await get(`${s.v4}/Items?$orderby=${path}`)).status, 400);
    });

  it("through a navigation, and in an $expand", async () => {
    const kids = await get(
      `${s.v4}/Kids?$filter=${encodeURIComponent("Item/Addr/City eq 'Athens'")}&$orderby=Item/Addr/City`,
    );
    assert.deepEqual(
      kids.body.value.map((k: { ID: number }) => k.ID),
      [1],
    );
    const items = await get(
      `${s.v4}/Items(1)/Kids?$filter=${encodeURIComponent("Item/Place/Addr/City eq 'Zurich'")}`,
    );
    assert.equal(items.body.value.length, 1);
  });

  it("in V2", async () => {
    assert.deepEqual(await filter("Addr/City eq 'Athens'", s.v2), [1]);
    assert.deepEqual(
      await ids("$orderby=Addr/City,ID&$select=ID", s.v2),
      [3, 4, 1, 2],
    );
  });

  it("in $apply's filter", async () => {
    const { status, body } = await get(
      `${s.v4}/Items?$apply=filter(Addr/City eq 'Athens')/aggregate($count as C)`,
    );
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(Number(body.value[0].C), 1);
  });

  // The rows, as $select writes them, without their ETags
  const selected = async (query: string) => {
    const { status, body } = await get(`${s.v4}/Items?$orderby=ID&${query}`);
    assert.equal(status, 200, JSON.stringify(body));
    return body;
  };

  it("$select picks its fields, and the context lists the path", async () => {
    const body = await selected("$select=ID,Addr/City");
    assert.match(body["@odata.context"], /#Items\(ID,Addr\/City\)$/);
    assert.deepEqual(body.value, [
      { ID: 1, Addr: { City: "Athens" } },
      { ID: 2, Addr: { City: "Berlin" } },
      { ID: 3, Addr: { City: null } },
      { ID: 4, Addr: null },
    ]);
  });

  it("$select goes into a nested complex value, and each item of a collection", async () => {
    const { value } = await selected(
      "$select=Place/Addr/City,Place/Col,Place/Stops/Addr/City",
    );
    assert.deepEqual(value[0], {
      Place: {
        Addr: { City: "Zurich" },
        Col: "Red",
        Stops: [{ Addr: { City: "Rome" } }],
      },
    });
    assert.deepEqual(value[3], { Place: null });
  });

  it("$select of a complex value whole, and a path into it, gives it whole", async () => {
    const { value } = await selected("$select=Addr/City,Addr");
    assert.deepEqual(value[2], { Addr: { City: null, Zip: "1" } });
  });

  it("$select of a path, on an entity and in an $expand", async () => {
    const one = await get(`${s.v4}/Items(1)?$select=Addr/City`);
    assert.match(one.body["@odata.context"], /#Items\(Addr\/City\)\/\$entity$/);
    assert.deepEqual(one.body.Addr, { City: "Athens" });
    const kids = await get(`${s.v4}/Kids?$expand=Item($select=Place/Addr)`);
    assert.equal(kids.status, 200, JSON.stringify(kids.body));
    const { "@odata.etag": _, ...item } = kids.body.value[0].Item;
    assert.deepEqual(item, { Place: { Addr: { City: "Zurich", Zip: null } } });
  });

  for (const [path, message] of [
    ["Addr/Nope", /Nope is not a property of Addr/],
    ["Addr/City/Nope", /City isn't a complex property/],
    ["Place/Cols/Red", /Cols isn't a complex property/],
    ["Name/City", /Name isn't a complex property/],
    ["Nope/City", /Nope is not a property or navigation of Item/],
    ["Addr/", /is not a property of Addr/],
    ["Kids/ID", /write \$expand=Kids\(\$select=ID\)/],
  ] as const)
    it(`$select=${path} is a 400 that says why`, async () => {
      const { status, body } = await get(`${s.v4}/Items?$select=${path}`);
      assert.equal(status, 400, JSON.stringify(body));
      assert.match(body.error.message, message);
    });

  it("$select with a type cast in its path is a 501", async () => {
    const { status } = await get(`${s.v4}/Items?$select=Place/F.Place/Col`);
    assert.equal(status, 501);
  });

  it("$select of a path is a 400 in V2, which selects a complex value whole", async () => {
    const { status } = await get(`${s.v2}/Items?$select=Addr/City`);
    assert.equal(status, 400);
    const whole = await get(`${s.v2}/Items(1)?$select=Addr`, {
      accept: "application/json",
    });
    assert.equal(whole.body.d.Addr.City, "Athens");
  });
});
