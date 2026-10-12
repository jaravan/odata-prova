import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, type TestServer } from "./helpers.ts";

// A browser asks before a cross-origin request with headers of its own (a preflight): a
// header the answer doesn't allow fails the request, before the server sees it.
describe("CORS preflight", () => {
  let s: TestServer;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  const preflight = (url: string, headers?: string) =>
    fetch(url, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:8080",
        "access-control-request-method": "GET",
        ...(headers ? { "access-control-request-headers": headers } : {}),
      },
    });

  it("allows the headers UI5's V2 model sends with every request", async () => {
    // As Chrome sends them for an ODataModel reading $metadata
    const asked =
      "accept-language,maxdataserviceversion,sap-cancel-on-close,sap-contextid-accept";
    const res = await preflight(`${s.v2}/$metadata`, asked);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-headers"), asked);
    assert.match(
      res.headers.get("vary") ?? "",
      /Access-Control-Request-Headers/,
    );
  });

  it("without a header list, allows the OData ones", async () => {
    const res = await preflight(`${s.v4}/PurchaseOrderSet`);
    assert.equal(res.status, 204);
    assert.match(
      res.headers.get("access-control-allow-headers") ?? "",
      /OData-Version/,
    );
  });
});
