// A request's size doesn't decide how long it takes: a long literal is read for every row, and
// counts as the work it is. And a group has no size past which it stops adding up.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  batch,
  batchResponses,
  get,
  start,
  type TestServer,
} from "./helpers.ts";
import { responseText } from "../lib/work.ts";
import type { HttpError } from "../lib/query.ts";

const METADATA = `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices><Schema Namespace="N" xmlns="http://docs.oasis-open.org/odata/ns/edm"><EntityType Name="V"><Key><PropertyRef Name="ID"/></Key><Property Name="ID" Type="Edm.Int32" Nullable="false"/><Property Name="Text" Type="Edm.String"/><Property Name="Big" Type="Edm.Int64"/><Property Name="Amount" Type="Edm.Decimal"/></EntityType><EntityContainer Name="C"><EntitySet Name="Values" EntityType="N.V"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;

function modelWith(rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "large-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "metadata.xml"), METADATA);
  fs.writeFileSync(path.join(dir, "data", "Values.json"), JSON.stringify(rows));
  return dir;
}

const DIGITS = "9".repeat(500_000);

describe("a long literal", () => {
  let s: TestServer;
  let dir: string;
  before(async () => {
    dir = modelWith(
      Array.from({ length: 20000 }, (_, i) => ({ ID: i, Text: `t${i}` })),
    );
    s = await start(dir);
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const LONG = 2_000_000;
  for (const [what, filter] of [
    ["an addition", `Amount add ${DIGITS} gt 0`],
    ["a subtraction", `Amount sub ${DIGITS} gt 0`],
    ["a product", `Amount mul ${DIGITS} gt 0`],
    ["a quotient", `Amount div ${DIGITS} gt 0`],
    ["a remainder", `Amount mod ${DIGITS} gt 0`],
    ["a floor", `floor(${DIGITS}.5) gt 0`],
    ["a ceiling", `ceiling(${DIGITS}.5) gt 0`],
    ["text", `Text eq '${"x".repeat(LONG)}'`],
    ["a number", `Big eq ${"1".repeat(LONG)}`],
    ["a decimal", `Amount eq ${"1".repeat(LONG)}.5`],
    ["an in list", `Text in ('${"x".repeat(LONG)}')`],
  ])
    it(`of ${what}, on every row, is stopped soon`, async () => {
      const started = performance.now();
      const [part] = batchResponses(
        (
          await batch(s.v4, [
            {
              method: "GET",
              url: `Values?$filter=${encodeURIComponent(filter)}`,
            },
          ])
        ).text,
      );
      assert.equal(part.status, 400);
      assert.equal(part.body.error.code, "TooMuchWork", what);
      assert.ok(performance.now() - started < 8000);
    });

  it("negated, it's refused at the first row", async () => {
    const started = performance.now();
    const [part] = batchResponses(
      (
        await batch(s.v4, [
          {
            method: "GET",
            url: `Values?$filter=${encodeURIComponent(`-(${DIGITS}.5) lt 0`)}`,
          },
        ])
      ).text,
    );
    assert.equal(part.status, 400);
    assert.match(part.body.error.message, /digits/);
    assert.ok(performance.now() - started < 8000);
  });

  it("a short one reads every row", async () => {
    const { status, body } = await get(
      `${s.v4}/Values?$filter=${encodeURIComponent("Text ne 'x'")}&$count=true&$top=0`,
    );
    assert.equal(status, 200);
    assert.equal(body["@odata.count"], 20000);
  });
});

describe("a very large group", () => {
  it("sums and averages its decimals", async () => {
    const dir = modelWith(
      Array.from({ length: 130000 }, (_, i) => ({ ID: i, Amount: "1.50" })),
    );
    const s = await start(dir);
    try {
      const { status, body } = await get(
        `${s.v4}/Values?$apply=${encodeURIComponent("aggregate(Amount with sum as T,Amount with average as A)")}`,
      );
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(Number(body.value[0].T), 195000);
      assert.equal(Number(body.value[0].A), 1.5);
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a $batch that reads more than a response can hold", () => {
  it("is cut off with a refusal, and the server goes on", async () => {
    const wide = "x".repeat(2000);
    const dir = modelWith(
      Array.from({ length: 20000 }, (_, i) => ({ ID: i, Text: wide })),
    );
    const s = await start(dir);
    try {
      const reads = Array.from({ length: 600 }, () => ({
        method: "GET",
        url: "Values",
      }));
      const { status, text } = await batch(s.v4, reads);
      assert.equal(status, 200);
      const parts = batchResponses(text);
      assert.ok(parts.length < 600);
      const last = parts.at(-1)!;
      assert.equal(last.status, 400);
      assert.equal(last.body.error.code, "TooMuchWork");
      assert.equal((await get(`${s.v4}/Values(1)`)).status, 200);
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a few reads are all answered", async () => {
    const dir = modelWith([{ ID: 1 }]);
    const s = await start(dir);
    try {
      const reads = Array.from({ length: 50 }, () => ({
        method: "GET",
        url: "Values",
      }));
      const parts = batchResponses((await batch(s.v4, reads)).text);
      assert.equal(parts.length, 50);
      assert.ok(parts.every((p) => p.status === 200));
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a response too long for a string", () => {
  it("is a refusal, not a 500", () => {
    const body = {
      toJSON() {
        throw new RangeError("Invalid string length");
      },
    };
    assert.throws(
      () => responseText(body),
      (e: HttpError) => e.status === 400 && e.code === "TooMuchWork",
    );
  });

  it("any other mistake is left as it is", () => {
    const body = {
      toJSON() {
        throw new TypeError("mine");
      },
    };
    assert.throws(() => responseText(body), TypeError);
  });
});

describe("a large write", () => {
  const COUNT = 40000;
  const kids = Array.from({ length: COUNT }, (_, i) => ({ ID: i + 1 }));
  const FAMILIES = path.join(import.meta.dirname, "fixtures", "Families");

  it("takes time in proportion to its rows", async () => {
    const s = await start(FAMILIES);
    s.store.audit = false;
    try {
      const started = performance.now();
      const res = await fetch(`${s.v4}/Ps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ID: 1, Kids: kids }),
      });
      assert.equal(res.status, 201);
      assert.ok(performance.now() - started < 8000);
      assert.equal((await get(`${s.v4}/Ks(${COUNT})`)).status, 200);
      assert.equal((await get(`${s.v4}/Ks/$count`)).body, String(COUNT));
    } finally {
      await s.close();
    }
  });

  it("a key repeated at the end still fails, and undoes it all soon", async () => {
    const s = await start(FAMILIES);
    s.store.audit = false;
    try {
      const started = performance.now();
      const res = await fetch(`${s.v4}/Ps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ID: 1, Kids: [...kids, { ID: 1 }] }),
      });
      assert.equal(res.status, 409);
      assert.ok(performance.now() - started < 8000);
      assert.equal((await get(`${s.v4}/Ks/$count`)).body, "0");
      assert.equal((await get(`${s.v4}/Ps(1)`)).status, 404);
    } finally {
      await s.close();
    }
  });
});

describe("a number too long to calculate with", () => {
  let s: TestServer;
  let dir: string;
  before(async () => {
    dir = modelWith([{ ID: 1, Amount: "1.5" }]);
    s = await start(dir);
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const NINES = "9".repeat(320);
  for (const url of [
    `Values?$apply=${encodeURIComponent(`compute(Amount add ${NINES} as X)/aggregate(X with sum as Y)`)}`,
    `Values?$compute=${encodeURIComponent(`Amount add ${NINES} as X`)}`,
    `Values?$compute=${encodeURIComponent(`Amount mul ${"9".repeat(50)} as X`)}`,
  ])
    it(`${decodeURIComponent(url).slice(0, 44)}... is a 400, not a guess`, async () => {
      const { status, body } = await get(`${s.v4}/${url}`);
      assert.equal(status, 400);
      assert.match(body.error.message, /digits/);
    });

  it("up to what a decimal holds it's exact", async () => {
    // As text: JSON.parse would round it
    const res = await fetch(
      `${s.v4}/Values?$compute=${encodeURIComponent(`Amount add ${"9".repeat(30)} as X`)}`,
    );
    assert.equal(res.status, 200);
    assert.match(await res.text(), /"X":10{29}0\.5/);
  });
});

describe("a $batch of reads that are small to answer and long to do", () => {
  let s: TestServer;
  let dir: string;
  before(async () => {
    dir = modelWith(
      Array.from({ length: 20000 }, (_, i) => ({
        ID: i,
        Text: `t${i % 500}`,
        Amount: "1.5",
      })),
    );
    s = await start(dir);
    // It copies the store for each transaction: it would be most of what's timed
    s.store.audit = false;
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const [what, url] of [
    ["sort", `Values?$orderby=${encodeURIComponent("Text desc,ID")}&$top=1`],
    ["search", "Values?$search=t1&$top=1"],
    [
      "group",
      `Values?$apply=${encodeURIComponent("groupby((Text),aggregate(Amount with sum as T))")}&$top=1`,
    ],
    [
      "aggregate",
      `Values?$apply=${encodeURIComponent("aggregate(Amount with sum as T)")}`,
    ],
    ["rank", `Values?$apply=${encodeURIComponent("topcount(1,ID)")}`],
    [
      "distinct group",
      `Values?$apply=${encodeURIComponent("groupby((Text))")}&$top=1`,
    ],
  ])
    it(`1500 of a ${what} are stopped soon`, async () => {
      const started = performance.now();
      const reads = Array.from({ length: 1500 }, () => ({
        method: "GET",
        url,
      }));
      const parts = batchResponses((await batch(s.v4, reads)).text);
      const refused = parts.filter(
        (p) => p.body?.error?.code === "TooMuchWork",
      );
      assert.ok(refused.length, `none of ${parts.length} refused`);
      assert.ok(parts.some((p) => p.status === 200));
      assert.ok(performance.now() - started < 8000);
    });

  it("one of each is fine", async () => {
    for (const url of [
      "Values?$orderby=Text desc,ID&$top=1",
      "Values?$search=t1&$top=1",
      `Values?$apply=${encodeURIComponent("groupby((Text),aggregate(Amount with sum as T))")}`,
    ])
      assert.equal((await get(`${s.v4}/${url}`)).status, 200, url);
  });
});

describe("updates and deletes on a large set", () => {
  it("don't search it again for each", async () => {
    const dir = modelWith(
      Array.from({ length: 200000 }, (_, i) => ({ ID: i })),
    );
    const s = await start(dir);
    s.store.audit = false;
    try {
      const type = s.model.entityTypes["N.V"];
      const row = s.store.find("Values", type, { ID: 199999 })!;
      const started = performance.now();
      for (let i = 0; i < 2000; i++) {
        s.store.update("Values", row, { Text: `v${i}` });
        assert.ok(s.store.find("Values", type, { ID: 199999 + (i % 1) }));
      }
      for (let i = 199000; i < 199500; i++) {
        s.store.remove("Values", type, { ID: i });
        assert.equal(s.store.find("Values", type, { ID: i }), undefined);
      }
      assert.ok(performance.now() - started < 1500);
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a key changed, removed or undone is found as it is now", async () => {
    const dir = modelWith([{ ID: 1 }, { ID: 2 }]);
    const s = await start(dir);
    try {
      const type = s.model.entityTypes["N.V"];
      const find = (ID: number) => s.store.find("Values", type, { ID });
      assert.ok(find(1));
      const row = find(1)!;
      s.store.update("Values", row, { ID: 5 });
      assert.equal(find(1), undefined);
      assert.equal(find(5), row);
      const mark = s.store.begin();
      s.store.remove("Values", type, { ID: 5 });
      assert.equal(find(5), undefined);
      s.store.rollback(mark);
      assert.equal(find(5), row);
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
