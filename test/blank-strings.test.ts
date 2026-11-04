import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start, get, send, type TestServer } from "./helpers.ts";

// A blank is a value of a string, as ABAP has it, and not the same as null
const MODEL = path.join(import.meta.dirname, "fixtures", "Blanks");

describe("an empty string", () => {
  let s: TestServer;
  before(async () => (s = await start(MODEL)));
  after(() => s.close());

  it("a create keeps it, on V4 and V2", async () => {
    const v4 = await send("POST", `${s.v4}/Notes`, {
      ID: "a",
      Required: "",
      Text: "",
    });
    assert.equal(v4.status, 201);
    assert.equal(v4.body.Required, "");
    assert.equal(v4.body.Text, "");
    const v2 = await send("POST", `${s.v2}/Notes`, {
      ID: "b",
      Required: "",
    });
    assert.equal(v2.status, 201);
    assert.equal(v2.body.d.Required, "");
  });

  it("a Nullable=false property can be blanked, not nulled", async () => {
    await send("POST", `${s.v4}/Notes`, { ID: "c", Required: "x" });
    const blank = await send("PATCH", `${s.v4}/Notes('c')`, { Required: "" });
    assert.equal(blank.status, 204);
    assert.equal((await get(`${s.v4}/Notes('c')`)).body.Required, "");
    const nulled = await send("PATCH", `${s.v4}/Notes('c')`, {
      Required: null,
    });
    assert.equal(nulled.status, 400);
  });

  it("$filter tells it from null", async () => {
    await send("POST", `${s.v4}/Notes`, { ID: "d", Required: "x", Text: "" });
    await send("POST", `${s.v4}/Notes`, { ID: "e", Required: "x" });
    const ids = async (filter: string) =>
      (
        await get(
          `${s.v4}/Notes?$select=ID&$filter=${encodeURIComponent(filter)}`,
        )
      ).body.value.map((r: { ID: string }) => r.ID);
    assert.ok((await ids("Text eq ''")).includes("d"));
    assert.ok(!(await ids("Text eq ''")).includes("e"));
    assert.ok((await ids("Text eq null")).includes("e"));
    assert.ok(!(await ids("Text eq null")).includes("d"));
  });

  it("inside a complex value and a collection", async () => {
    const res = await send("POST", `${s.v4}/Notes`, {
      ID: "f",
      Required: "x",
      Addr: { City: "" },
      Tags: [""],
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.Addr.City, "");
    assert.deepEqual(res.body.Tags, [""]);
  });

  it("for a number or a date is still no value: UI5 sends it for a cleared field", async () => {
    const res = await send("POST", `${s.v4}/Notes`, {
      ID: "g",
      Required: "x",
      Count: "",
      Day: "",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.Count, null);
    assert.equal(res.body.Day, null);
  });

  it("is no key", async () => {
    const res = await send("POST", `${s.v4}/Notes`, { ID: "", Required: "x" });
    assert.equal(res.status, 400);
  });

  it("a CSV cell left empty is null, a JSON data file's empty string isn't", async () => {
    const csv = (await get(`${s.v4}/FromCsv('c1')`)).body;
    assert.equal(csv.Text, null);
    assert.equal(csv.Count, null);
    const json = (await get(`${s.v4}/FromJson('j1')`)).body;
    assert.equal(json.Text, "");
    assert.equal(json.Required, "");
  });
});
