const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { start, get, send, batch, batchResponses } = require("./helpers");

const TRIPPIN = path.join(__dirname, "fixtures", "real", "TripPin");
const GATEWAY_OPS = path.join(__dirname, "fixtures", "OperationsV2");
const NS = "Microsoft.OData.SampleService.Models.TripPin";

// The server routes the call, checks the method, reads and logs the parameters, and answers
// per the return type; it doesn't know what the operation does.
describe("V4 actions and functions (TripPin)", () => {
  let s, logs, user;
  before(async () => {
    logs = [];
    s = await start(TRIPPIN, { mockRows: 3, log: (l) => logs.push(l) });
    user = (await get(`${s.v4}/People?$top=1&$select=UserName`)).body.value[0]
      .UserName;
  });
  after(() => s.close());

  it("function import returning an entity: a row of its EntitySet, parameters from the path", async () => {
    const r = await get(`${s.v4}/GetNearestAirport(lat=33.9,lon=-118.4)`);
    assert.equal(r.status, 200);
    assert.match(r.body["@odata.context"], /#Airports\/\$entity$/);
    assert.ok(r.body.IcaoCode);
    assert.ok(
      logs.includes('function GetNearestAirport {"lat":33.9,"lon":-118.4}'),
    );
  });

  it("action import with no return type -> 204", async () => {
    assert.equal((await send("POST", `${s.v4}/ResetDataSource`)).status, 204);
  });

  it("bound function, qualified or not, returning another entity type", async () => {
    const qualified = await get(
      `${s.v4}/People('${user}')/${NS}.GetFavoriteAirline()`,
    );
    assert.equal(qualified.status, 200);
    assert.match(qualified.body["@odata.context"], /#Airlines\/\$entity$/);
    const unqualified = await get(
      `${s.v4}/People('${user}')/GetFavoriteAirline()`,
    );
    assert.equal(unqualified.body.AirlineCode, qualified.body.AirlineCode);
  });

  it("bound action: parameters from the body, logged with the entity it was called on", async () => {
    const r = await send("POST", `${s.v4}/People('${user}')/${NS}.ShareTrip`, {
      userName: "bob",
      tripId: 1,
    });
    assert.equal(r.status, 204);
    assert.ok(
      logs.includes(
        `action ShareTrip on /odata/v4/T/People('${user}') {"userName":"bob","tripId":1}`,
      ),
    );
  });

  it("wrong method -> 405, naming the right one", async () => {
    const getAction = await get(`${s.v4}/People('${user}')/${NS}.ShareTrip`);
    assert.equal(getAction.status, 405);
    assert.match(
      getAction.body.error.message,
      /ShareTrip is an action: call it with POST/,
    );
    const postFunction = await send(
      "POST",
      `${s.v4}/GetNearestAirport(lat=1,lon=2)`,
    );
    assert.equal(postFunction.status, 405);
  });

  it("unknown names and composed paths", async () => {
    const unknown = await get(`${s.v4}/NoSuchThing`);
    assert.equal(unknown.status, 404);
    assert.match(
      unknown.body.error.message,
      /NoSuchThing is not an entity set or operation/,
    );
    const composed = await get(
      `${s.v4}/People('${user}')/${NS}.GetFavoriteAirline()/Name`,
    );
    assert.equal(composed.status, 501);
    assert.equal(
      (await get(`${s.v4}/GetNearestAirport(lat=@a,lon=1)?@a=1`)).status,
      501,
    );
  });

  it("on V2, as function imports: a bound operation takes the entity's key and names its type in sap:action-for", async () => {
    const metadata = (await get(`${s.v2}/$metadata`)).body;
    assert.match(
      metadata,
      /<FunctionImport Name="GetNearestAirport" ReturnType="[^"]+\.Airport" EntitySet="Airports" m:HttpMethod="GET">/,
    );
    assert.match(
      metadata,
      /<FunctionImport Name="ShareTrip" m:HttpMethod="POST" sap:action-for="[^"]+\.Person">\s*<Parameter Name="UserName"/,
    );

    const airport = await get(`${s.v2}/GetNearestAirport?lat=1&lon=2`);
    assert.equal(airport.status, 200);
    assert.ok(airport.body.d.IcaoCode);

    const share = await send(
      "POST",
      `${s.v2}/ShareTrip?UserName='${user}'&userName='bob'&tripId=1`,
    );
    assert.equal(share.status, 204);
    assert.ok(
      logs.includes(
        `action ShareTrip on /odata/v2/T/People('${user}') {"UserName":"${user}","userName":"bob","tripId":1}`,
      ),
    );
    assert.equal(
      (await send("POST", `${s.v2}/ShareTrip?UserName='nobody'`)).status,
      404,
    );

    const airline = await get(`${s.v2}/GetFavoriteAirline?UserName='${user}'`);
    assert.equal(airline.status, 200);
    assert.ok(airline.body.d.AirlineCode);
  });

  it("on V2, an operation bound to a type without an entity set is left out, and logged", async () => {
    assert.doesNotMatch(
      (await get(`${s.v2}/$metadata`)).body,
      /GetInvolvedPeople/,
    );
    assert.ok(
      s.model.warnings.includes(
        "not in V2: function GetInvolvedPeople: no entity set for Trip",
      ),
    );
  });

  it("works inside $batch", async () => {
    const r = await batch(s.v4, [
      [
        {
          method: "POST",
          url: `People('${user}')/${NS}.ShareTrip`,
          body: { userName: "amy", tripId: 2 },
        },
      ],
      { method: "GET", url: "GetNearestAirport(lat=1,lon=2)" },
    ]);
    assert.equal(r.status, 200);
    assert.deepEqual(
      batchResponses(r.text).map((p) => p.status),
      [204, 200],
    );
    assert.ok(logs.some((l) => l.includes('"userName":"amy"')));
  });
});

describe("V2 function imports (SAP Gateway style)", () => {
  let s, logs;
  before(async () => {
    logs = [];
    s = await start(GATEWAY_OPS, { log: (l) => logs.push(l) });
  });
  after(() => s.close());

  it("action for an entity: parameters from the query string, returns the entity whose key they carry", async () => {
    const r = await send(
      "POST",
      `${s.v2}/ApprovePurchaseOrder?PurchaseOrderId='4500000002'`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.d.PurchaseOrderId, "4500000002");
    assert.ok(
      logs.includes(
        `action ApprovePurchaseOrder on /odata/v2/T/PurchaseOrderSet('4500000002') {"PurchaseOrderId":"4500000002"}`,
      ),
    );
    assert.equal(
      (
        await send(
          "POST",
          `${s.v2}/ApprovePurchaseOrder?PurchaseOrderId='nope'`,
        )
      ).status,
      404,
    );
  });

  it("function returning a collection of entities, with query options", async () => {
    const r = await get(`${s.v2}/GetOpenOrders?$filter=Status eq 'Open'`);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.d.results.map((o) => o.PurchaseOrderId),
      ["4500000001"],
    );
  });

  it("primitive, complex and collection results, as Gateway sends them", async () => {
    assert.deepEqual((await get(`${s.v2}/GetStatusText?Status='Open'`)).body, {
      d: { GetStatusText: "" },
    });
    const totals = (await get(`${s.v2}/GetTotals`)).body.d.GetTotals;
    assert.equal(totals.__metadata.type, "ZPO_SRV.Totals");
    assert.equal(totals.Count, 0);
    assert.deepEqual((await get(`${s.v2}/GetOrderDates`)).body, {
      d: { results: [] },
    });
  });

  it("m:HttpMethod decides the method; no return type -> 204", async () => {
    assert.equal((await send("POST", `${s.v2}/ReleaseAll`)).status, 204);
    assert.equal((await get(`${s.v2}/ReleaseAll`)).status, 405);
    assert.equal((await send("POST", `${s.v2}/GetOpenOrders`)).status, 405);
  });

  it("on V4: an import with sap:action-for and the key as parameters is an action bound to that type", async () => {
    const metadata = (await get(`${s.v4}/$metadata`)).body;
    // EntitySetPath: it returns the entity it was called on, so UI5 updates the page with it
    assert.match(
      metadata,
      /<Action Name="ApprovePurchaseOrder" IsBound="true" EntitySetPath="_it">\s*<Parameter Name="_it" Type="ZPO_SRV.PurchaseOrder" Nullable="false"\/>\s*<ReturnType Type="ZPO_SRV.PurchaseOrder"\/>/,
    );
    const r = await send(
      "POST",
      `${s.v4}/PurchaseOrderSet('4500000001')/ZPO_SRV.ApprovePurchaseOrder`,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.PurchaseOrderId, "4500000001");
  });

  it("on V4: the other imports are action and function imports", async () => {
    const metadata = (await get(`${s.v4}/$metadata`)).body;
    assert.match(
      metadata,
      /<FunctionImport Name="GetOpenOrders" Function="ZPO_SRV.GetOpenOrders" EntitySet="PurchaseOrderSet"/,
    );
    assert.match(
      metadata,
      /<ActionImport Name="ReleaseAll" Action="ZPO_SRV.ReleaseAll"\/>/,
    );
    assert.equal(
      (await get(`${s.v4}/GetOpenOrders()?$filter=Status eq 'Open'`)).body.value
        .length,
      1,
    );
    assert.equal(
      (await get(`${s.v4}/GetStatusText(Status='Open')`)).body.value,
      "",
    );
    assert.equal((await send("POST", `${s.v4}/ReleaseAll`)).status, 204);
  });
});

describe("config.json rules: what an operation changes", () => {
  const fs = require("fs");
  const os = require("os");
  // A copy of the V2 fixture with the given config.json, removed after the tests
  const dirs = [];
  function modelWith(config) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ops-"));
    dirs.push(dir);
    fs.cpSync(GATEWAY_OPS, dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
    return dir;
  }
  after(() =>
    dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })),
  );

  it("sets the properties on the entity, seen on both protocols", async () => {
    const s = await start(
      modelWith({
        operations: {
          ApprovePurchaseOrder: { set: { Status: "Approved", Amount: 99.5 } },
        },
      }),
    );
    try {
      const v2 = await send(
        "POST",
        `${s.v2}/ApprovePurchaseOrder?PurchaseOrderId='4500000001'`,
      );
      assert.equal(v2.body.d.Status, "Approved");
      assert.equal(v2.body.d.Amount, "99.5");
      const v4 = await get(`${s.v4}/PurchaseOrderSet('4500000001')`);
      assert.equal(v4.body.Status, "Approved");
    } finally {
      await s.close();
    }
  });

  it("a rule for an unknown operation or property is a startup error", async () => {
    await assert.rejects(
      start(modelWith({ operations: { Approve: { set: { Status: "x" } } } })),
      /operations\.Approve: no operation of that name acts on an entity/,
    );
    await assert.rejects(
      start(
        modelWith({
          operations: { ApprovePurchaseOrder: { set: { Colour: "x" } } },
        }),
      ),
      /operations\.ApprovePurchaseOrder\.set: PurchaseOrder has no property Colour/,
    );
  });
});
