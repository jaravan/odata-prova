import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMetadata } from "../lib/metadata.ts";
import { writeMockData } from "../lib/mock-data.ts";
import {
  start,
  get,
  send,
  batch,
  batchResponses,
  type TestServer,
} from "./helpers.ts";

// A many-to-many link with no ReferentialConstraint: Student.Courses and Course.Students
// share the link set Courses-Students, which data/Courses-Students.csv fills. Compilers (10)
// has Ada (1) and Linus (2), Kernels (20) has Ada.
const MODEL = path.join(import.meta.dirname, "fixtures", "ManyToMany");

const ids = (rows: Record<string, number>[], key: string) =>
  rows.map((r) => r[key]);

describe("a navigation through a link set", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  it("is logged, and shared by the navigation and its partner", () => {
    assert.deepEqual(s.model.warnings.sort(), [
      "navigation with links of its own: Course.Students in Courses-Students (no ReferentialConstraint; a data file can fill it)",
      "navigation with links of its own: Student.Courses in Courses-Students (no ReferentialConstraint; a data file can fill it)",
    ]);
    const student = s.model.entityTypes["School.Student"];
    assert.equal(student.navigations.Courses.partner, "Students");
  });

  it("links both ways, in V2 and V4", async () => {
    assert.deepEqual(
      ids((await get(`${s.v4}/Students(1)/Courses`)).body.value, "CourseId"),
      [10, 20],
    );
    assert.deepEqual(
      ids((await get(`${s.v4}/Courses(10)/Students`)).body.value, "StudentId"),
      [1, 2],
    );
    assert.deepEqual(
      ids(
        (await get(`${s.v2}/Students(2)/Courses`)).body.d.results,
        "CourseId",
      ),
      [10],
    );
  });

  it("expands, and filters with any and all", async () => {
    const expanded = await get(
      `${s.v4}/Courses?$expand=Students($select=Name)&$select=Title`,
    );
    assert.deepEqual(expanded.body.value, [
      { Title: "Compilers", Students: [{ Name: "Ada" }, { Name: "Linus" }] },
      { Title: "Kernels", Students: [{ Name: "Ada" }] },
    ]);
    const any = await get(
      `${s.v4}/Students?$filter=Courses/any(c:c/Title eq 'Kernels')&$select=Name`,
    );
    assert.deepEqual(any.body.value, [{ Name: "Ada" }]);
    const v2 = await get(
      `${s.v2}/Students?$expand=Courses&$select=Name,Courses/Title`,
    );
    assert.deepEqual(
      v2.body.d.results.map(
        (r: { Courses: { results: unknown[] } }) => r.Courses.results.length,
      ),
      [2, 1],
    );
  });

  it("has no constraint in $metadata: many on both ends", async () => {
    const v2 = (await get(`${s.v2}/$metadata`)).body as string;
    const v4 = (await get(`${s.v4}/$metadata`)).body as string;
    assert.doesNotMatch(v4, /ReferentialConstraint|Students_StudentId/);
    assert.match(
      v4,
      /Name="Courses" Type="Collection\(School.Course\)" Partner="Students"/,
    );
    // The V4 document, generated from the V2 one, reads back to the same link set
    const again = parseMetadata(v4);
    assert.deepEqual(Object.keys(again.linkSets), ["Courses-Students"]);
    assert.match(v2, /Multiplicity="\*"/);
  });
});

describe("writes through a link set", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  it("a create through the navigation, or a deep insert, links the new entity", async () => {
    const created = await send("POST", `${s.v4}/Students(2)/Courses`, {
      CourseId: 30,
      Title: "Databases",
    });
    assert.equal(created.status, 201);
    assert.deepEqual(
      ids((await get(`${s.v4}/Students(2)/Courses`)).body.value, "CourseId"),
      [10, 30],
    );
    assert.deepEqual(
      ids((await get(`${s.v4}/Courses(30)/Students`)).body.value, "StudentId"),
      [2],
    );

    const deep = await send("POST", `${s.v4}/Students`, {
      StudentId: 3,
      Name: "Grace",
      Courses: [{ CourseId: 40, Title: "Networks" }],
    });
    assert.equal(deep.status, 201);
    assert.deepEqual(
      ids((await get(`${s.v4}/Courses(40)/Students`)).body.value, "StudentId"),
      [3],
    );
  });

  it("a delete takes the entity's links with it", async () => {
    assert.equal((await send("DELETE", `${s.v4}/Students(1)`)).status, 204);
    assert.deepEqual(
      ids((await get(`${s.v4}/Courses(10)/Students`)).body.value, "StudentId"),
      [2],
    );
    assert.deepEqual(
      (await get(`${s.v4}/Courses(20)/Students`)).body.value,
      [],
    );
    // The course itself is still there
    assert.equal((await get(`${s.v4}/Courses(20)`)).status, 200);
  });

  it("a failed $batch changeset takes its links back", async () => {
    const r = await batch(s.v4, [
      [
        {
          method: "POST",
          url: "Students(2)/Courses",
          body: { CourseId: 50, Title: "Graphics" },
        },
        { method: "POST", url: "Courses", body: { CourseId: 50 } }, // a duplicate key
      ],
    ]);
    assert.equal(batchResponses(r.text)[0].status, 409);
    assert.deepEqual(
      ids((await get(`${s.v4}/Students(2)/Courses`)).body.value, "CourseId"),
      [10, 30],
    );
  });
});

describe("a self-link through a link set: TripPin's Person.Friends", () => {
  let dir: string;
  let s: TestServer;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "links-"));
    fs.copyFileSync(
      path.join(
        import.meta.dirname,
        "fixtures",
        "real",
        "TripPin",
        "metadata.xml",
      ),
      path.join(dir, "metadata.xml"),
    );
    s = await start(dir, { mockRows: 8 });
  });
  after(async () => {
    await s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("generated data links people to other people", async () => {
    const people = (
      await get(
        `${s.v4}/People?$expand=Friends($select=UserName)&$select=UserName`,
      )
    ).body.value as { UserName: string; Friends: { UserName: string }[] }[];
    assert.ok(people.some((p) => p.Friends.length > 0));
    for (const p of people)
      assert.ok(
        p.Friends.every((f) => f.UserName !== p.UserName),
        `${p.UserName} is not their own friend`,
      );
  });

  it("odata-prova-mock-data writes the link set as a file", () => {
    const written = writeMockData(dir, 4);
    assert.ok(
      written.some((w) => w.file === path.join("data", "People-Friends.csv")),
    );
    const header = fs
      .readFileSync(path.join(dir, "data", "People-Friends.csv"), "utf8")
      .split("\n")[0];
    assert.equal(header, "UserName;Friends_UserName");
  });
});
