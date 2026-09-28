const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { start, get, send, batch, batchResponses } = require("./helpers");

const TRIPPIN = path.join(__dirname, "fixtures", "real", "TripPin");
const GATEWAY_OPS = path.join(__dirname, "fixtures", "OperationsV2");
const NS = "Microsoft.OData.SampleService.Models.TripPin";

// The mock doesn't know what an operation does: it routes the call, checks the method, reads
// the parameters, logs it, and answers with what the return type allows.
describe("V4 actions and functions (TripPin)", () => {
  let s, logs, user;
  before(async () => {
    logs = [];
    s = await start(TRIPPIN, { mockRows: 3, log: (l) => logs.push(l) });
    user = (await get(`${s.v4}/People?$top=1&$select=UserName`)).body.value[0].UserName;
  });
  after(() => s.close());

  it("function import returning an entity: a row of its EntitySet, parameters from the path", async () => {
    const r = await get(`${s.v4}/GetNearestAirport(lat=33.9,lon=-118.4)`);
    assert.equal(r.status, 200);
    assert.match(r.body["@odata.context"], /#Airports\/\$entity$/);
    assert.ok(r.body.IcaoCode);
    assert.ok(logs.includes('function GetNearestAirport {"lat":33.9,"lon":-118.4}'));
  });

  it("action import with no return type -> 204", async () => {
    assert.equal((await send("POST", `${s.v4}/ResetDataSource`)).status, 204);
  });

  it("bound function, qualified or not, returning another entity type", async () => {
    const qualified = await get(`${s.v4}/People('${user}')/${NS}.GetFavoriteAirline()`);
    assert.equal(qualified.status, 200);
    assert.match(qualified.body["@odata.context"], /#Airlines\/\$entity$/);
    const unqualified = await get(`${s.v4}/People('${user}')/GetFavoriteAirline()`);
    assert.equal(unqualified.body.AirlineCode, qualified.body.AirlineCode);
  });

  it("bound action: parameters from the body, logged with the entity it was called on", async () => {
    const r = await send("POST", `${s.v4}/People('${user}')/${NS}.ShareTrip`, { userName: "bob", tripId: 1 });
    assert.equal(r.status, 204);
    assert.ok(logs.includes(`action ShareTrip on /odata/v4/T/People('${user}') {"userName":"bob","tripId":1}`));
  });

  it("wrong method -> 405, naming the right one", async () => {
    const getAction = await get(`${s.v4}/People('${user}')/${NS}.ShareTrip`);
    assert.equal(getAction.status, 405);
    assert.match(getAction.body.error.message, /ShareTrip is an action: call it with POST/);
    const postFunction = await send("POST", `${s.v4}/GetNearestAirport(lat=1,lon=2)`);
    assert.equal(postFunction.status, 405);
  });

  it("unknown names and composed paths", async () => {
    const unknown = await get(`${s.v4}/NoSuchThing`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error.message, /NoSuchThing is not an entity set or operation/);
    const composed = await get(`${s.v4}/People('${user}')/${NS}.GetFavoriteAirline()/Name`);
    assert.equal(composed.status, 501);
    assert.equal((await get(`${s.v4}/GetNearestAirport(lat=@a,lon=1)?@a=1`)).status, 501);
  });

  it("operations are served on the protocol the metadata was written for only", async () => {
    assert.equal((await get(`${s.v2}/GetNearestAirport`)).status, 404);
    assert.doesNotMatch((await get(`${s.v2}/$metadata`)).body, /GetNearestAirport/);
  });

  it("works inside $batch", async () => {
    const r = await batch(s.v4, [
      [{ method: "POST", url: `People('${user}')/${NS}.ShareTrip`, body: { userName: "amy", tripId: 2 } }],
      { method: "GET", url: "GetNearestAirport(lat=1,lon=2)" },
    ]);
    assert.equal(r.status, 200);
    assert.deepEqual(batchResponses(r.text).map((p) => p.status), [204, 200]);
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
    const r = await send("POST", `${s.v2}/ApprovePurchaseOrder?PurchaseOrderId='4500000002'`);
    assert.equal(r.status, 200);
    assert.equal(r.body.d.PurchaseOrderId, "4500000002");
    assert.ok(logs.includes('action ApprovePurchaseOrder {"PurchaseOrderId":"4500000002"}'));
    assert.equal((await send("POST", `${s.v2}/ApprovePurchaseOrder?PurchaseOrderId='nope'`)).status, 404);
  });

  it("function returning a collection of entities, with query options", async () => {
    const r = await get(`${s.v2}/GetOpenOrders?$filter=Status eq 'Open'`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.d.results.map((o) => o.PurchaseOrderId), ["4500000001"]);
  });

  it("primitive, complex and collection results, as Gateway sends them", async () => {
    assert.deepEqual((await get(`${s.v2}/GetStatusText?Status='Open'`)).body, { d: { GetStatusText: "" } });
    const totals = (await get(`${s.v2}/GetTotals`)).body.d.GetTotals;
    assert.equal(totals.__metadata.type, "ZPO_SRV.Totals");
    assert.equal(totals.Count, 0);
    assert.deepEqual((await get(`${s.v2}/GetOrderDates`)).body, { d: { results: [] } });
  });

  it("m:HttpMethod decides the method; no return type -> 204", async () => {
    assert.equal((await send("POST", `${s.v2}/ReleaseAll`)).status, 204);
    assert.equal((await get(`${s.v2}/ReleaseAll`)).status, 405);
    assert.equal((await send("POST", `${s.v2}/GetOpenOrders`)).status, 405);
  });
});
