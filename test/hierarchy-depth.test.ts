// A hierarchy can be as deep as it has rows: one chain of nodes is answered, and soon.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start, type TestServer } from "./helpers.ts";

const SOURCE = path.join(import.meta.dirname, "fixtures", "HierarchySrv");
const DEPTH = 30000;

describe("a hierarchy of one long chain", () => {
  let s: TestServer;
  let dir: string;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-"));
    fs.mkdirSync(path.join(dir, "data"));
    fs.copyFileSync(
      path.join(SOURCE, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    const header = fs
      .readFileSync(path.join(SOURCE, "data", "Genres.csv"), "utf8")
      .split(/\r?\n/)[0];
    const separator = header.includes(";") ? ";" : ",";
    const columns = header.split(separator);
    const cell = (column: string, id: number) =>
      /^id$/i.test(column)
        ? id
        : /parent/i.test(column)
          ? id === 1
            ? ""
            : id - 1
          : /name/i.test(column)
            ? `N${id}`
            : "";
    const rows = Array.from({ length: DEPTH }, (_, i) =>
      columns.map((c) => cell(c, i + 1)).join(separator),
    );
    fs.writeFileSync(
      path.join(dir, "data", "Genres.csv"),
      [header, ...rows].join("\n"),
    );
    s = await start(dir);
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const count = async (apply: string, query = "") => {
    const res = await fetch(
      `${s.v4}/Genres?$apply=${encodeURIComponent(apply)}&$count=true&$top=1${query}`,
    );
    const body = (await res.json()) as { "@odata.count": number };
    assert.equal(res.status, 200, JSON.stringify(body));
    return body["@odata.count"];
  };
  const H = "$root/Genres,GenresHierarchy,ID";

  for (const [apply, expected] of [
    [`descendants(${H},filter(ID eq 1))`, DEPTH - 1],
    [`descendants(${H},filter(ID lt 15000))`, DEPTH - 1],
    [`descendants(${H},filter(ID eq 1),3)`, 3],
    [`descendants(${H},filter(ID lt 3),2)`, 3],
    [`ancestors(${H},filter(ID eq ${DEPTH}))`, DEPTH - 1],
    [`ancestors(${H},filter(ID gt 15000))`, DEPTH - 1],
    [`ancestors(${H},filter(ID eq ${DEPTH}),2)`, 2],
    [`traverse(${H},preorder)`, DEPTH],
    [`traverse(${H},postorder)`, DEPTH],
    [
      `com.sap.vocabularies.Hierarchy.v1.TopLevels(HierarchyNodes=$root/Genres,HierarchyQualifier='GenresHierarchy',NodeProperty='ID')`,
      DEPTH,
    ],
  ] as const)
    it(`${apply.slice(0, 60)}`, async () => {
      assert.equal(await count(apply), expected);
    });

  it("doesn't hold everything else up", async () => {
    const started = performance.now();
    await count(`descendants(${H},filter(ID lt 15000))`);
    assert.ok(performance.now() - started < 5000);
  });
});
