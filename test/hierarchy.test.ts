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

  it("Show expands the ancestors of a node, even one ExpandLevels collapses", async () => {
    const shown = await apply(topLevels(',Levels=1,Show=["5"]'), SELECT);
    assert.deepEqual(nodes(shown.body.value), [
      [1, "expanded", 0, 4, 0],
      [2, "leaf", 1, 0, 1],
      [3, "leaf", 1, 0, 2],
      [4, "expanded", 1, 1, 3],
      [5, "leaf", 2, 0, 4],
      [6, "collapsed", 0, 0, 5],
    ]);
    const ids = async (params: string) =>
      (await apply(topLevels(params), SELECT)).body.value.map(
        (n: { ID: number }) => n.ID,
      );
    assert.deepEqual(
      await ids(
        ',Levels=2,ExpandLevels=[{"NodeID":"6","Levels":0}],Show=["8"]',
      ),
      [1, 2, 3, 4, 6, 7, 8],
    );
    // A node that isn't among the rows is left alone
    assert.deepEqual(await ids(',Levels=1,Show=["99"]'), [1, 6]);
  });

  it("a mistake -> 400; nodes other than an entity set -> 501", async () => {
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
      [topLevels(",Show=['1']"), 400, /Invalid \$apply: Show/],
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

describe("traverse", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  const traverse = async (transformations: string, rest = "&$select=ID") => {
    const r = await get(
      `${s.v4}/Genres?$apply=${encodeURIComponent(transformations)}${rest}`,
    );
    return r;
  };
  const ids = async (transformations: string) => {
    const r = await traverse(transformations);
    assert.equal(r.status, 200, transformations);
    return r.body.value.map((n: { ID: number }) => n.ID);
  };
  const T = "traverse($root/Genres,GenresHierarchy,ID";

  it("puts parents before their children (preorder) or after them (postorder)", async () => {
    assert.deepEqual(await ids(`${T},preorder)`), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(await ids(`${T},postorder)`), [2, 3, 5, 4, 1, 8, 7, 6]);
  });

  it("sorts roots and siblings by the expressions after the order", async () => {
    assert.deepEqual(
      await ids(`${T},preorder,name desc)`),
      [6, 7, 8, 1, 3, 4, 5, 2],
    );
  });

  it("keeps a node in its place when its parent isn't among the rows", async () => {
    assert.deepEqual(
      await ids(`filter(ID ne 4)/${T},preorder)`),
      [1, 2, 3, 5, 6, 7, 8],
    );
  });

  it("keeps the rows entities, with nothing filled in", async () => {
    const r = await traverse(
      `filter(ID ge 7)/${T},preorder)`,
      "&$select=ID,DrillState&$expand=parent($select=ID)",
    );
    assert.deepEqual(r.body.value, [
      { ID: 7, DrillState: null, parent: { ID: 6 } },
      { ID: 8, DrillState: null, parent: { ID: 7 } },
    ]);
  });

  it("a mistake -> 400", async () => {
    for (const transformations of [
      `${T},inorder)`,
      `${T})`,
      "traverse($root/Genres,Nope,ID,preorder)",
    ]) {
      const r = await traverse(transformations);
      assert.equal(r.status, 400, transformations);
    }
  });
});

// What UI5 sends to expand a node (its children), and to search or filter (the matches and
// their ancestors, then TopLevels)
describe("ancestors and descendants", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  const H = "$root/Genres,GenresHierarchy,ID";
  const ids = async (transformations: string, select = "ID") => {
    const r = await get(
      `${s.v4}/Genres?$apply=${encodeURIComponent(transformations)}&$select=${select}`,
    );
    assert.equal(r.status, 200, transformations);
    return r.body.value;
  };

  it("descendants: a node's children, or all below it, with the start node when kept", async () => {
    assert.deepEqual(
      await ids(
        `descendants(${H},filter(ID eq 1),1)`,
        "ID,DrillState,DistanceFromRoot",
      ),
      [
        { ID: 2, DrillState: "leaf", DistanceFromRoot: 1 },
        { ID: 3, DrillState: "leaf", DistanceFromRoot: 1 },
        { ID: 4, DrillState: "collapsed", DistanceFromRoot: 1 },
      ],
    );
    assert.deepEqual(
      await ids(
        `descendants(${H},filter(ID eq 1))`,
        "ID,DrillState,LimitedDescendantCount",
      ),
      [
        { ID: 2, DrillState: "leaf", LimitedDescendantCount: 0 },
        { ID: 3, DrillState: "leaf", LimitedDescendantCount: 0 },
        { ID: 4, DrillState: "expanded", LimitedDescendantCount: 1 },
        { ID: 5, DrillState: "leaf", LimitedDescendantCount: 0 },
      ],
    );
    assert.deepEqual(
      await ids(`descendants(${H},filter(ID eq 6),1,keep start)`),
      [{ ID: 6 }, { ID: 7 }],
    );
  });

  it("ancestors, then TopLevels: the matches with their ancestors, expanded down to them", async () => {
    const all =
      "com.sap.vocabularies.Hierarchy.v1.TopLevels(HierarchyNodes=$root/Genres," +
      "HierarchyQualifier='GenresHierarchy',NodeProperty='ID')";
    assert.deepEqual(
      await ids(
        `ancestors(${H},search(Auto),keep start)/${all}`,
        "ID,DrillState,DistanceFromRoot",
      ),
      [
        { ID: 6, DrillState: "expanded", DistanceFromRoot: 0 },
        { ID: 7, DrillState: "expanded", DistanceFromRoot: 1 },
        { ID: 8, DrillState: "leaf", DistanceFromRoot: 2 },
      ],
    );
    // Two matches share an ancestor, which shows once
    assert.deepEqual(
      await ids(`ancestors(${H},filter(ID eq 2 or ID eq 5),keep start)/${all}`),
      [{ ID: 1 }, { ID: 2 }, { ID: 4 }, { ID: 5 }],
    );
    assert.deepEqual(await ids(`ancestors(${H},filter(ID eq 8),1)`), [
      { ID: 7 },
    ]);
    assert.deepEqual(await ids(`ancestors(${H},filter(ID eq 1))`), []);
  });

  it("a mistake -> 400", async () => {
    for (const transformations of [
      `descendants(${H})`,
      `descendants(${H},filter(ID eq 1),0)`,
      `descendants(${H},filter(ID eq 1),keep)`,
      `descendants(${H},filter(ID eq 1),1,1)`,
      "descendants($root/Genres,Nope,ID,filter(ID eq 1))",
      "descendants($root/Genres,GenresHierarchy,name,filter(ID eq 1))",
      `ancestors(${H},filter(Nope eq 1))`,
    ]) {
      const r = await get(
        `${s.v4}/Genres?$apply=${encodeURIComponent(transformations)}`,
      );
      assert.equal(r.status, 400, transformations);
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
