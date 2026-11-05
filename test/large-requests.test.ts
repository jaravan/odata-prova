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
      assert.equal(part.body.error.code, "TooMuchWork");
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
