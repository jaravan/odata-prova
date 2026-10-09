import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send } from "./helpers.js";
import { parseMetadata } from "../lib/metadata.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");

// Services the server was not written for. Each must load, serve a self-consistent $metadata
// in both versions (the one it was not written in is generated), and answer on every entity set.
const SERVICES = [
  { dir: "real/NorthwindV2", disabledNavigations: 4 }, // many-to-many links
  // many-to-many links, ShipVia -> Shipper, and Employee's self-links (ReportsTo), which a join
  // by naming would match key to key: every employee their own manager
  { dir: "real/NorthwindV4", disabledNavigations: 8 },
  // containment, streams, Flight's no-key links, and Person.Friends (many-to-many with itself)
  { dir: "real/TripPin", disabledNavigations: 8 },
  { dir: "GatewaySrv", disabledNavigations: 0 },
];

// Every non-Edm type a $metadata document uses must be defined in it, and every entity type
// needs a key; otherwise clients such as UI5 reject the document.
function assertSelfConsistent(xml, label) {
  const defined = new Set(
    [
      ...xml.matchAll(/<(?:ComplexType|EnumType|EntityType) Name="([^"]+)"/g),
    ].map((m) => m[1]),
  );
  const used = [...xml.matchAll(/ Type="(?:Collection\()?([\w.]+)\)?"/g)]
    .map((m) => m[1])
    .filter((t) => !t.startsWith("Edm."));
  for (const type of used)
    assert.ok(
      defined.has(type.split(".").pop()),
      `${label}: ${type} is used but not defined`,
    );
  assert.doesNotMatch(
    xml,
    /<Key>\s*<\/Key>/,
    `${label}: an entity type has no key`,
  );
}

for (const { dir, disabledNavigations } of SERVICES) {
  describe(`real metadata: ${dir}`, () => {
    let s;
    before(async () => {
      s = await start(path.join(FIXTURES, dir));
    });
    after(() => s.close());

    it("loads, disabling only the navigations it cannot join", () => {
      const disabled = s.model.warnings.filter((w) =>
        w.startsWith("navigation disabled:"),
      );
      assert.equal(disabled.length, disabledNavigations, disabled.join("\n"));
    });

    it("serves a self-consistent $metadata in both versions", async () => {
      for (const root of [s.v2, s.v4]) {
        const xml = (await get(`${root}/$metadata`)).body;
        assert.doesNotThrow(() => parseMetadata(xml));
        assertSelfConsistent(xml, root);
      }
    });

    it("answers on every entity set in both versions", async () => {
      for (const set of Object.keys(s.model.entitySets))
        for (const root of [s.v2, s.v4])
          assert.equal(
            (await get(`${root}/${set}`)).status,
            200,
            `${root}/${set}`,
          );
    });
  });
}

describe("complex types, enums and collections on the wire", () => {
  let trip, gw;
  before(async () => {
    trip = await start(path.join(FIXTURES, "real/TripPin"));
    gw = await start(path.join(FIXTURES, "GatewaySrv"));
  });
  after(async () => {
    await trip.close();
    await gw.close();
  });

  it("V4 returns nested complex values, collections and enum members", async () => {
    const p = (await get(`${trip.v4}/People('russellwhyte')`)).body;
    assert.deepEqual(p.Emails, ["Russell@example.com", "Russell@contoso.com"]);
    assert.deepEqual(p.AddressInfo[0].City, {
      CountryRegion: "United States",
      Name: "Boise",
      Region: "ID",
    });
    assert.equal(p.Gender, "Male");
  });

  it("V2 has no collection-valued properties: left out, and a 404 when asked for", async () => {
    const p = (await get(`${trip.v2}/People('russellwhyte')`)).body.d;
    assert.equal("Emails" in p, false);
    assert.equal("AddressInfo" in p, false);
    assert.equal(p.Gender, "Male"); // enums are strings in V2
    assert.equal(
      (await get(`${trip.v2}/People('russellwhyte')/Emails`)).status,
      404,
    );
  });

  it("a Gateway-style complex property in both protocols", async () => {
    const v2 = (await get(`${gw.v2}/BusinessPartnerSet('0100000000')`)).body.d;
    assert.deepEqual(v2.Address, {
      __metadata: { type: "GATEWAY_SRV.CT_Address" },
      Street: "Dietmar-Hopp-Allee 16",
      City: "Walldorf",
      PostalCode: "69190",
      Country: "DE",
    });
    const v4 = (await get(`${gw.v4}/BusinessPartnerSet('0100000000')`)).body;
    assert.deepEqual(v4.Address, {
      Street: "Dietmar-Hopp-Allee 16",
      City: "Walldorf",
      PostalCode: "69190",
      Country: "DE",
    });
    assert.equal(v4.CreatedAt, "2025-01-20T09:30:00.0000000Z"); // Precision="7"
  });

  it("writes a complex value through V4 and reads it through V2", async () => {
    const r = await send("PATCH", `${gw.v4}/BusinessPartnerSet('0100000000')`, {
      Address: { City: "Berlin" },
    });
    assert.equal(r.status, 204);
    const v2 = (await get(`${gw.v2}/BusinessPartnerSet('0100000000')`)).body.d;
    assert.equal(v2.Address.City, "Berlin");
    assert.equal(v2.Address.Street, null); // PATCH replaces the complex value as a whole
  });

  it("rejects a malformed complex value with 400", async () => {
    const r = await send("PATCH", `${gw.v4}/BusinessPartnerSet('0100000000')`, {
      Address: "Walldorf",
    });
    assert.equal(r.status, 400);
  });
});
