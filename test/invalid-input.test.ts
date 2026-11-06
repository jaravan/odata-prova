// What isn't valid is a 400, not a request read as another one: $orderby=Status foo isn't
// $orderby=Status, and 2025-13-01 isn't a date.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { propToInternal, toInternal } from "../lib/types.ts";
import type { Property } from "../lib/model.ts";
import {
  batch,
  batchResponses,
  get,
  send,
  ORDER,
  start,
  type TestServer,
} from "./helpers.ts";

const statusOf = async (url: string) => (await get(encodeURI(url))).status;

describe("query options that can't be read", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const orders = () => `${s.v4}/PurchaseOrderSet`;

  for (const query of [
    "$orderby=TotalAmount eq 5",
    "$orderby=Status foo",
    "$orderby=Status desc asc",
    "$orderby=Status mul 2",
    "$orderby=Status asc,Currency sideways",
    "$apply=orderby(Status foo)",
    "$expand=Items($orderby=Material foo)",
    "$count=x",
    "$count=1",
    "$expand=Items($count=x)",
  ]) {
    it(`${query} is a 400`, async () => {
      assert.equal(await statusOf(`${orders()}?${query}`), 400);
    });
  }

  it("V2's $orderby is read the same way", async () => {
    assert.equal(
      await statusOf(`${s.v2}/PurchaseOrderSet?$orderby=Status foo`),
      400,
    );
  });

  for (const query of [
    "$orderby=Status",
    "$orderby=Status asc",
    "$orderby=Status desc",
    "$orderby=Status DESC",
    "$orderby=Status  desc , Currency",
    "$count=true",
    "$count=false",
    "$count=",
    "$expand=Items($count=true)",
  ]) {
    it(`${query} is still fine`, async () => {
      assert.equal(await statusOf(`${orders()}?${query}`), 200);
    });
  }

  it("$count=TRUE is true, not false", async () => {
    const { body } = await get(`${orders()}?$count=TRUE`);
    assert.equal(typeof body["@odata.count"], "number");
  });

  it("$orderby=Status DESC still sorts down", async () => {
    const ids = async (query: string) =>
      (await get(encodeURI(`${orders()}?${query}&$select=Status`))).body.value;
    assert.deepEqual(
      await ids("$orderby=Status DESC"),
      await ids("$orderby=Status desc"),
    );
  });

  it("V2's $inlinecount is allpages or none", async () => {
    const root = `${s.v2}/PurchaseOrderSet`;
    assert.equal(await statusOf(`${root}?$inlinecount=x`), 400);
    assert.equal(await statusOf(`${root}?$inlinecount=ALLPAGES`), 400);
    assert.equal(await statusOf(`${root}?$inlinecount=none`), 200);
    const { body } = await get(`${root}?$inlinecount=allpages`);
    assert.equal(typeof body.d.__count, "string");
  });
});

describe("a long number where text belongs", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "EdmTypes"));
  });
  after(() => s.close());

  const post = (ID: number, field: string, literal: string) =>
    fetch(`${s.v4}/Values`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"ID":${ID},"${field}":${literal}}`,
    });

  for (const [field, literal] of [
    ["Day", "1234567890123456"],
    ["Day", "12345"],
    ["Took", "1234567890123456"],
  ])
    it(`${field}: ${literal} is a 400`, async () => {
      const res = await post(600, field, literal);
      assert.equal(res.status, 400);
      assert.match(await res.text(), /expected a string/);
    });

  it("where a number belongs, it keeps every digit", async () => {
    const res = await post(601, "Big", "9007199254740993");
    assert.equal(res.status, 201);
    const text = await (await fetch(`${s.v4}/Values(601)?$select=Big`)).text();
    assert.match(text, /9007199254740993/);
    const decimal = await post(602, "Amount", "12345678901234567890.123456");
    assert.equal(decimal.status, 201);
    assert.match(
      await (await fetch(`${s.v4}/Values(602)?$select=Amount`)).text(),
      /12345678901234567890\.123456/,
    );
    assert.equal((await post(603, "V", "0.12345678901234567")).status, 201);
  });

  it("a long number as text is still text where it's wanted", async () => {
    assert.equal((await post(604, "Big", '"9007199254740993"')).status, 201);
  });

  it("a long number isn't an object or an entity either", async () => {
    for (const body of ["1234567890123456", "[1234567890123456]"]) {
      const res = await fetch(`${s.v4}/Values`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(res.status, 400, body);
    }
  });
});

describe("a long number in a string property", () => {
  it("is a 400, in a $batch too", async () => {
    const s = await start(
      path.join(import.meta.dirname, "fixtures", "Spellings"),
    );
    try {
      const direct = await fetch(`${s.v4}/Rows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"ID":70,"Text":1234567890123456}',
      });
      assert.equal(direct.status, 400);
      const part = batchResponses(
        (
          await batch(s.v4, [
            { method: "POST", url: "Rows", body: { ID: 71, Text: 1e15 } },
          ])
        ).text,
      )[0];
      assert.equal(part.status, 400);
      const text = await fetch(`${s.v4}/Rows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"ID":72,"Text":"1234567890123456"}',
      });
      assert.equal(text.status, 201);
    } finally {
      await s.close();
    }
  });
});

describe("values that aren't one", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const filter = (expression: string) =>
    statusOf(`${s.v4}/PurchaseOrderSet?$filter=${expression}`);

  for (const expression of [
    "OrderDate gt 2025-13-01",
    "OrderDate gt 2025-02-30",
    "OrderDate gt 2025-00-10",
    "round('a') eq 1",
    "floor(Status) eq 1",
    "ceiling(true) eq 1",
    "Status add 1 eq 2",
    "1 sub Status eq 2",
    "OrderDate add 1 eq 2",
  ]) {
    it(`$filter=${expression} is a 400`, async () => {
      assert.equal(await filter(expression), 400);
    });
  }

  for (const expression of [
    "OrderDate gt 2024-02-29",
    "round('1.5') eq 2",
    "round(TotalAmount) gt 0",
    "TotalAmount add 1 gt 0",
    "round(null) eq 1",
    "Status add null eq 2",
    "substring(Status,1) eq 'x'",
  ]) {
    it(`$filter=${expression} is still fine`, async () => {
      assert.equal(await filter(expression), 200);
    });
  }

  it("a time of PT says nothing", () => {
    assert.throws(() => toInternal("PT", "Edm.TimeOfDay"), /Invalid/);
    assert.equal(toInternal("PT1H", "Edm.TimeOfDay"), "01:00:00");
  });

  for (const offset of ["+99:99", "+24:00", "-24:00", "+00:60", "+23:60"]) {
    it(`a time zone of ${offset} is a 400 in a body`, async () => {
      const { status } = await send("POST", `${s.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: "ZONE",
        OrderDate: `2025-01-01T00:00:00${offset}`,
      });
      assert.equal(status, 400);
    });
  }

  for (const offset of ["+23:59", "-23:59", "+14:00", "-00:00"]) {
    it(`a time zone of ${offset} is one`, async () => {
      const { status, body } = await send("POST", `${s.v4}/PurchaseOrderSet`, {
        ...ORDER,
        PurchaseOrderId: `Z${offset}`,
        OrderDate: `2025-06-15T12:00:00${offset}`,
      });
      assert.equal(status, 201, JSON.stringify(body));
    });
  }
});

describe("values at the edge of their type", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "Stamps"));
  });
  after(() => s.close());

  it("V2's X takes hex and nothing else", async () => {
    const filter = (text: string) =>
      get(`${s.v2}/Rs?$filter=${encodeURIComponent(`B eq ${text}`)}`);
    assert.equal((await filter("X'0'")).status, 400);
    assert.equal((await filter("X'zz'")).status, 400);
    assert.equal((await filter("X'01'")).status, 200);
  });

  it("a time without seconds is a time in a $filter too", async () => {
    const { status } = await get(
      `${s.v4}/Rs?$filter=${encodeURIComponent("Tm eq 12:00")}`,
    );
    assert.equal(status, 200);
  });

  it("toInternal reads the edges", () => {
    assert.throws(() => toInternal(1e39, "Edm.Single"), /Invalid/);
    assert.throws(() => toInternal(-1e39, "Edm.Single"), /Invalid/);
    assert.equal(toInternal(1e38, "Edm.Single"), 1e38);
    assert.equal(toInternal(1e39, "Edm.Double"), 1e39);
    assert.equal(toInternal("INF", "Edm.Single"), Infinity);
    assert.equal(toInternal("1.0", "Edm.Int64"), "1");
    assert.equal(toInternal("1.0", "Edm.Int16"), 1);
    assert.throws(() => toInternal("1.5", "Edm.Int64"), /Invalid/);
  });

  it("zeros ending a decimal don't count against its Scale", () => {
    const prop = {
      name: "D",
      type: "Edm.Decimal",
      elementType: "Edm.Decimal",
      precision: "5",
      scale: "2",
    } as Property;
    assert.equal(propToInternal("1.230", prop), "1.230");
    assert.throws(() => propToInternal("1.234", prop), /Invalid/);
  });
});

describe("text where a number is compared", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "EdmTypes"));
  });
  after(() => s.close());

  const filter = (expression: string, root = s.v4) =>
    statusOf(`${root}/Values?$filter=${expression}`);

  for (const expression of [
    "ID eq 'nope'",
    "'nope' eq ID",
    "ID ne 'nope'",
    "ID gt 'nope'",
    "Big eq 'nope'",
    "Amount eq 'nope'",
    "V eq 'nope'",
    "ID add 1 eq 'nope'",
    "ID eq ''",
    "ID in ('nope')",
    "ID in (1,'nope')",
    "ID lt 0 and ID eq 'nope'",
  ]) {
    it(`${expression} is a 400`, async () => {
      assert.equal(await filter(expression), 400);
    });
  }

  it("with no rows to reach, in V2 too", async () => {
    assert.equal(await filter("ID lt 0 and Big eq 'nope'", s.v2), 400);
  });

  for (const expression of [
    "ID eq '1'",
    "Amount eq '1.5'",
    "Big eq '5'",
    "V eq 'INF'",
    "V eq 'NaN'",
    "ID in ('1',2)",
  ]) {
    it(`${expression} is still a number`, async () => {
      assert.equal(await filter(expression), 200);
    });
  }
});

describe("an empty binary", () => {
  let s: TestServer;
  before(async () => {
    s = await start(path.join(import.meta.dirname, "fixtures", "Stamps"));
  });
  after(() => s.close());

  it("is a value, not null", async () => {
    const { status, body } = await send("POST", `${s.v4}/Rs`, { ID: 1, B: "" });
    assert.equal(status, 201);
    assert.equal(body.B, "");
    assert.equal((await get(`${s.v4}/Rs(1)`)).body.B, "");
  });

  it("is found as one, and isn't null", async () => {
    const ids = async (expression: string) =>
      (
        await get(
          `${s.v4}/Rs?$select=ID&$filter=${encodeURIComponent(expression)}`,
        )
      ).body.value.map((r: { ID: number }) => r.ID);
    await send("POST", `${s.v4}/Rs`, { ID: 2 });
    assert.deepEqual(await ids("B eq null"), [2]);
    assert.deepEqual(await ids("B ne null"), [1]);
  });

  it("its /$value has no bytes", async () => {
    const res = await fetch(`${s.v4}/Rs(1)/B/$value`);
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  it("a CSV's empty cell is still null", () => {
    const prop = {
      name: "B",
      type: "Edm.Binary",
      elementType: "Edm.Binary",
    } as Property;
    assert.equal(propToInternal(null, prop), null);
    assert.equal(propToInternal("", prop), "");
    assert.equal(toInternal("", "Edm.Binary"), "");
  });

  it("other types' empty text is still null", () => {
    assert.equal(toInternal("", "Edm.Int32"), null);
    assert.equal(toInternal("", "Edm.Date"), null);
  });
});
