// A name may hold any letter, as CSDL has it: every query option reads Größe and 名前 as it
// reads Size.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { get, start, type TestServer } from "./helpers.ts";

const MODEL = path.join(import.meta.dirname, "fixtures", "UnicodeNames");

describe("names beyond ASCII", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  const read = (url: string) => get(encodeURI(url));
  const keys = (rows: { Schlüssel: number }[]) => rows.map((r) => r.Schlüssel);

  for (const [query, expected] of [
    ["$filter=Größe eq 3", [1]],
    ["$filter=Größe gt 3", [2]],
    ["$filter=名前 eq 'イ'", [2]],
    ["$filter=Länd/Größe eq 20", [2]],
    ["$filter=contains(名前,'ア')", [1]],
    ["$orderby=Größe desc", [2, 1]],
    ["$orderby=Länd/Größe desc", [2, 1]],
    ["$compute=Größe mul 2 as Fläche&$filter=Fläche eq 10", [2]],
    ["$apply=topcount(1,Größe)", [2]],
    ["$apply=compute(Größe mul 2 as Fläche)/orderby(Fläche desc)", [2, 1]],
  ] as const) {
    it(query, async () => {
      const { status, body } = await read(`${s.v4}/Städte?${query}`);
      assert.equal(status, 200);
      assert.deepEqual(keys(body.value), expected);
    });
  }

  it("V2", async () => {
    const { status, body } = await read(
      `${s.v2}/Städte?$filter=Größe eq 3&$orderby=名前`,
    );
    assert.equal(status, 200);
    assert.deepEqual(keys(body.d.results), [1]);
  });

  it("a lambda", async () => {
    const { body } = await read(
      `${s.v4}/Länder?$filter=Städte/any(städte:städte/Größe eq 5)`,
    );
    assert.deepEqual(
      body.value.map((l: { Nr: number }) => l.Nr),
      [2],
    );
  });

  it("$apply's groupby and aggregate", async () => {
    const { body } = await read(
      `${s.v4}/Städte?$apply=groupby((Größe),aggregate(Jahr with sum as Summe))`,
    );
    assert.equal(body.value.length, 2);
    const total = await read(
      `${s.v4}/Städte?$apply=aggregate(Größe with sum as Gesamtgröße)`,
    );
    assert.equal(Number(total.body.value[0].Gesamtgröße), 8);
  });

  it("a key with its names", async () => {
    const { status, body } = await read(
      `${s.v4}/Städte(Schlüssel=2,Jahr=2000)`,
    );
    assert.equal(status, 200);
    assert.equal(body.Größe, 5);
  });

  it("an unknown name is still a 400", async () => {
    for (const q of ["$filter=Größé eq 3", "$orderby=Größé", "$select=Größé"])
      assert.equal((await read(`${s.v4}/Städte?${q}`)).status, 400, q);
  });
});
