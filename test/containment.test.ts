import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMetadata } from "../lib/metadata.ts";
import { writeMockData } from "../lib/mock-data.ts";
import { start, get, send, type TestServer } from "./helpers.ts";

// Person.Trips and Trip.PlanItems contain their targets, which no entity set holds: they get
// the server's own, People-Trips and People-Trips-PlanItems, filled by data files with their
// parents' keys. ann has trips 1 (Rome, with the Colosseum and the Forum) and 2 (Oslo); ben
// has a trip 1 too (Paris, with the Louvre).
const MODEL = path.join(import.meta.dirname, "fixtures", "Containment");

const names = (rows: { Name: string }[]) => rows.map((r) => r.Name);

describe("containment", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  it("is logged, with the entity set a data file fills", () => {
    assert.deepEqual(s.model.warnings, [
      "navigation with an entity set of its own: Person.Trips in People-Trips (containment; a data file can fill it)",
      "navigation with an entity set of its own: Trip.PlanItems in People-Trips-PlanItems (containment; a data file can fill it)",
    ]);
  });

  it("reaches the contained entities through their parent, whose keys tell them apart", async () => {
    assert.deepEqual(
      names((await get(`${s.v4}/People('ann')/Trips`)).body.value),
      ["Rome", "Oslo"],
    );
    assert.equal(
      (await get(`${s.v4}/People('ann')/Trips(1)`)).body.Name,
      "Rome",
    );
    assert.equal(
      (await get(`${s.v4}/People('ben')/Trips(1)`)).body.Name,
      "Paris",
    );
    assert.deepEqual(
      names((await get(`${s.v4}/People('ben')/Trips(1)/PlanItems`)).body.value),
      ["Louvre"],
    );
    assert.equal((await get(`${s.v4}/People('ben')/Trips(2)`)).status, 404);
  });

  it("expands and filters, with no parent keys in the response", async () => {
    const r = await get(
      `${s.v4}/People?$expand=Trips($select=Name;$expand=PlanItems($select=Name))&$filter=Trips/any(t:t/Name eq 'Paris')`,
    );
    assert.deepEqual(r.body.value, [
      {
        UserName: "ben",
        Trips: [{ Name: "Paris", PlanItems: [{ Name: "Louvre" }] }],
      },
    ]);
    const trip = (await get(`${s.v4}/People('ann')/Trips(1)`)).body;
    assert.equal("Person_UserName" in trip, false);
  });

  it("isn't an entity set of the service, nor in V2", async () => {
    assert.equal((await get(`${s.v4}/People-Trips`)).status, 404);
    assert.deepEqual(
      (await get(`${s.v4}/`)).body.value.map((e: { name: string }) => e.name),
      ["People"],
    );
    assert.deepEqual((await get(`${s.v2}/`)).body.d.EntitySets, ["People"]);
    const v2 = (await get(`${s.v2}/$metadata`)).body as string;
    assert.doesNotMatch(v2, /People-Trips|Name="Trips"|Name="PlanItems"/);
    assert.doesNotThrow(() => parseMetadata(v2));
    const trips = await get(`${s.v2}/People('ann')/Trips`);
    assert.equal(trips.status, 404);
    assert.match(trips.body.error.message.value, /not available in OData V2/);
    assert.equal("Trips" in (await get(`${s.v2}/People('ann')`)).body.d, false);
  });
});

describe("writes to contained entities", () => {
  let s: TestServer;
  before(async () => {
    s = await start(MODEL);
  });
  after(() => s.close());

  it("a create under the parent, at the parent's URL; a key is unique only there", async () => {
    const created = await send("POST", `${s.v4}/People('ben')/Trips`, {
      TripId: 2,
      Name: "Lisbon",
    });
    assert.equal(created.status, 201);
    assert.equal(
      created.headers.get("location"),
      "/odata/v4/T/People('ben')/Trips(2)",
    );
    assert.equal(
      (await get(`${s.v4}/People('ann')/Trips(2)`)).body.Name,
      "Oslo",
    );
    const twice = await send("POST", `${s.v4}/People('ben')/Trips`, {
      TripId: 2,
    });
    assert.equal(twice.status, 409);
  });

  it("an update or delete touches only the parent's own", async () => {
    await send("PATCH", `${s.v4}/People('ann')/Trips(1)`, { Name: "Naples" });
    assert.equal(
      (await get(`${s.v4}/People('ann')/Trips(1)`)).body.Name,
      "Naples",
    );
    assert.equal(
      (await get(`${s.v4}/People('ben')/Trips(1)`)).body.Name,
      "Paris",
    );

    assert.equal(
      (await send("DELETE", `${s.v4}/People('ann')/Trips(1)`)).status,
      204,
    );
    assert.equal((await get(`${s.v4}/People('ann')/Trips(1)`)).status, 404);
    assert.equal((await get(`${s.v4}/People('ben')/Trips(1)`)).status, 200);
    // ann's trip 1 took its plan items with it
    assert.equal(
      s.store
        .rows("People-Trips-PlanItems")
        .filter((r) => r.Person_UserName === "ann").length,
      0,
    );
  });

  it("deleting the parent deletes what it contains, all the way down", async () => {
    assert.equal((await send("DELETE", `${s.v4}/People('ben')`)).status, 204);
    assert.equal(
      s.store.rows("People-Trips").filter((r) => r.Person_UserName === "ben")
        .length,
      0,
    );
    assert.equal(
      s.store
        .rows("People-Trips-PlanItems")
        .filter((r) => r.Person_UserName === "ben").length,
      0,
    );
  });
});

describe("contained entities in generated data", () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "containment-"));
    fs.copyFileSync(
      path.join(MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("each belongs to a real parent", async () => {
    const s = await start(dir, { mockRows: 4 });
    try {
      const people = (await get(`${s.v4}/People?$expand=Trips`)).body.value;
      const trips = people.flatMap((p: { Trips: unknown[] }) => p.Trips);
      assert.equal(trips.length, 4);
    } finally {
      await s.close();
    }
  });

  it("odata-prova-mock-data writes them with their parent's keys", () => {
    writeMockData(dir, 3);
    const header = fs
      .readFileSync(path.join(dir, "data", "People-Trips.csv"), "utf8")
      .split("\n")[0];
    assert.equal(header, "TripId;Name;Person_UserName");
  });
});
