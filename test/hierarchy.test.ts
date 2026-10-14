import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMetadata } from "../lib/metadata.ts";
import { start, get, type TestServer } from "./helpers.ts";

// Genres, as CAP's bookshop has them:
//
//   1 Fiction              6 Non-Fiction
//     2 Drama                7 Biography
//     3 Poetry                 8 Autobiography
//     4 Fantasy
//       5 Epic Fantasy
const MODEL = path.join(import.meta.dirname, "fixtures", "HierarchySrv");
const XML = fs.readFileSync(path.join(MODEL, "metadata.xml"), "utf8");

// TopLevels as UI5 sends it, with these parameters after the hierarchy's
const topLevels = (params = "") =>
  "com.sap.vocabularies.Hierarchy.v1.TopLevels(HierarchyNodes=$root/Genres," +
  `HierarchyQualifier='GenresHierarchy',NodeProperty='ID'${params})`;

describe("recursive hierarchies in the metadata", () => {
  it("reads both annotations, by their names or the older ones ending in Property", () => {
    const genres = parseMetadata(XML).entityTypes["HierarchySrv.Genres"];
    assert.deepEqual(genres.hierarchies, {
      GenresHierarchy: {
        nodeProperty: "ID",
        parentNavigation: "parent",
        drillState: "DrillState",
        distanceFromRoot: "DistanceFromRoot",
        limitedDescendantCount: "LimitedDescendantCount",
        limitedRank: "LimitedRank",
      },
    });
    const older = XML.replace(
      '"DrillState" Path=',
      '"DrillStateProperty" PropertyPath=',
    );
    assert.equal(
      parseMetadata(older).entityTypes["HierarchySrv.Genres"].hierarchies
        ?.GenresHierarchy.drillState,
      "DrillState",
    );
  });

  it("ignores one without a node property or parent navigation, with a warning", () => {
    const model = parseMetadata(
      XML.replace(
        '<PropertyValue Property="NodeProperty" PropertyPath="ID"/>',
        "",
      ),
    );
    assert.equal(
      model.entityTypes["HierarchySrv.Genres"].hierarchies,
      undefined,
    );
    assert.ok(
      model.warnings.some((w) =>
        /hierarchy ignored: Genres#GenresHierarchy/.test(w),
      ),
    );
  });
});

describe("TopLevels", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  const apply = (transformations: string, rest = "") =>
    get(`${s.v4}/Genres?$apply=${encodeURIComponent(transformations)}${rest}`);
  const SELECT =
    "&$select=ID,DrillState,DistanceFromRoot,LimitedDescendantCount,LimitedRank";
  // [ID, DrillState, DistanceFromRoot, LimitedDescendantCount, LimitedRank] of each node
  const nodes = (value: Record<string, unknown>[]) =>
    value.map((n) => [
      n.ID,
      n.DrillState,
      n.DistanceFromRoot,
      n.LimitedDescendantCount,
      n.LimitedRank,
    ]);

  it("the first levels in preorder, with the hierarchy's properties filled in", async () => {
    const one = await apply(topLevels(",Levels=1"), SELECT);
    assert.equal(one.status, 200);
    assert.deepEqual(nodes(one.body.value), [
      [1, "collapsed", 0, 0, 0],
      [6, "collapsed", 0, 0, 1],
    ]);

    const two = await apply(topLevels(",Levels=2"), `${SELECT}&$count=true`);
    assert.equal(two.body["@odata.count"], 6);
    assert.deepEqual(nodes(two.body.value), [
      [1, "expanded", 0, 3, 0],
      [2, "leaf", 1, 0, 1],
      [3, "leaf", 1, 0, 2],
      [4, "collapsed", 1, 0, 3],
      [6, "expanded", 0, 1, 4],
      [7, "collapsed", 1, 0, 5],
    ]);

    const all = await apply(topLevels(), SELECT);
    assert.deepEqual(
      all.body.value.map((n: { ID: number }) => n.ID),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
  });

  it("ExpandLevels expands a node by levels, all of them (null), or collapses it (0)", async () => {
    const expanded = await apply(
      topLevels(
        ',Levels=1,ExpandLevels=[{"NodeID":"1","Levels":1},{"NodeID":"6","Levels":null}]',
      ),
      SELECT,
    );
    assert.deepEqual(nodes(expanded.body.value), [
      [1, "expanded", 0, 3, 0],
      [2, "leaf", 1, 0, 1],
      [3, "leaf", 1, 0, 2],
      [4, "collapsed", 1, 0, 3],
      [6, "expanded", 0, 2, 4],
      [7, "expanded", 1, 1, 5],
      [8, "leaf", 2, 0, 6],
    ]);

    const collapsed = await apply(
      topLevels(',Levels=2,ExpandLevels=[{"NodeID":"1","Levels":0}]'),
      SELECT,
    );
    assert.deepEqual(nodes(collapsed.body.value), [
      [1, "collapsed", 0, 0, 0],
      [6, "expanded", 0, 1, 1],
      [7, "collapsed", 1, 0, 2],
    ]);
  });

  it("orders siblings as the rows before it, and keeps them entities", async () => {
    const r = await apply(
      `orderby(name desc)/${topLevels(",Levels=2")}`,
      "&$select=ID&$expand=parent($select=name)",
    );
    assert.deepEqual(r.body.value, [
      { ID: 6, parent: null },
      { ID: 7, parent: { name: "Non-Fiction" } },
      { ID: 1, parent: null },
      { ID: 3, parent: { name: "Fiction" } },
      { ID: 4, parent: { name: "Fiction" } },
      { ID: 2, parent: { name: "Fiction" } },
    ]);
  });

  it("a mistake -> 400; Show, or nodes other than an entity set -> 501", async () => {
    for (const [transformations, status, message] of [
      [
        topLevels().replace("'GenresHierarchy'", "'Nope'"),
        400,
        /Nope is not a recursive hierarchy of Genres/,
      ],
      [
        topLevels().replace("NodeProperty='ID'", "NodeProperty='name'"),
        400,
        /node property is ID, not name/,
      ],
      [topLevels(",Levels=0"), 400, /Invalid \$apply: Levels=0/],
      [topLevels(",ExpandLevels=[{}]"), 400, /Invalid \$apply: ExpandLevels/],
      [topLevels(",ExpandLevels=nope"), 400, /Invalid \$apply: ExpandLevels/],
      [topLevels(",Nope=1"), 400, /Nope is not a parameter/],
      [
        topLevels().replace(",HierarchyQualifier='GenresHierarchy'", ""),
        400,
        /needs HierarchyQualifier/,
      ],
      [topLevels(",Show=['1']"), 501, /Show is not supported/],
      [
        topLevels().replace("$root/Genres", "$root/Genres(1)/children"),
        501,
        /must be an entity set/,
      ],
    ] as const) {
      const r = await apply(transformations);
      assert.equal(r.status, status, transformations);
      assert.match(r.body.error.message, message, transformations);
    }
  });
});

// Generated rows point at random parents, which can go round in a cycle: every node still
// shows, once
describe("TopLevels on generated rows", () => {
  let s: TestServer;
  let dir: string;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hierarchy-"));
    const model = path.join(dir, "HierarchySrv");
    fs.mkdirSync(model);
    fs.writeFileSync(path.join(model, "metadata.xml"), XML);
    s = await start(model, { mockRows: 30 });
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("shows every node once", async () => {
    const r = await get(
      `${s.v4}/Genres?$apply=${encodeURIComponent(topLevels())}&$select=ID,DistanceFromRoot`,
    );
    assert.equal(r.status, 200);
    const ids = r.body.value.map((n: { ID: number }) => n.ID);
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30);
  });
});
