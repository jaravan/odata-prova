// The Docker image, run as users run it: a model copied in at /models/<ServiceName>, the
// server on port 3000. Needs Docker, so it isn't part of `yarn test`: build the image, then
// `yarn test:image` (IMAGE names another tag).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { GenericContainer, Wait } from "testcontainers";

const IMAGE = process.env.IMAGE ?? "odata-prova:test";
const MODEL = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "PurchaseOrderSrv",
);

// A container serving the PurchaseOrderSrv fixture, ready once /healthz answers
function serve() {
  return new GenericContainer(IMAGE)
    .withCopyDirectoriesToContainer([
      { source: MODEL, target: "/models/PurchaseOrderSrv" },
    ])
    .withExposedPorts(3000)
    .withWaitStrategy(Wait.forHttp("/healthz", 3000))
    .start();
}

describe("the Docker image", () => {
  let container, base;
  before(async () => {
    container = await serve();
    base = `http://${container.getHost()}:${container.getMappedPort(3000)}`;
  });
  after(() => container?.stop());

  it("finds the mounted model and serves it as V2 and V4", async () => {
    const root = await (await fetch(`${base}/`)).json();
    assert.deepEqual(root, {
      model: "PurchaseOrderSrv",
      services: [
        { odataVersion: "2.0", root: "/odata/v2/PurchaseOrderSrv/" },
        { odataVersion: "4.0", root: "/odata/v4/PurchaseOrderSrv/" },
      ],
    });
    for (const version of ["v2", "v4"]) {
      const r = await fetch(
        `${base}/odata/${version}/PurchaseOrderSrv/PurchaseOrderSet/$count`,
      );
      assert.equal(r.status, 200, version);
      assert.ok(Number(await r.text()) > 0, version);
    }
  });

  it("runs as the node user, not root", async () => {
    const { output } = await container.exec(["id", "-un"]);
    assert.equal(output.trim(), "node");
  });

  it("holds the compiled JavaScript and production dependencies only", async () => {
    const app = (await container.exec(["ls", "/app"])).output.split(/\s+/);
    for (const file of ["server.js", "mock-data.js", "lib", "package.json"])
      assert.ok(app.includes(file), file);
    assert.ok(!app.includes("server.ts"));
    const { exitCode } = await container.exec([
      "sh",
      "-c",
      "ls /app/node_modules | grep -qxE 'typescript|eslint|prettier|testcontainers'",
    ]);
    assert.equal(exitCode, 1, "a devDependency is in the image");
  });

  it("writes mock data with the documented command", async () => {
    // A model with no data files, in a folder the node user can write to
    const { output, exitCode } = await container.exec([
      "sh",
      "-c",
      "mkdir -p /tmp/m && cp /models/PurchaseOrderSrv/metadata.xml /tmp/m/ && node mock-data.js /tmp/m 3",
    ]);
    assert.equal(exitCode, 0, output);
    assert.match(output, /wrote data\/PurchaseOrderSet\.csv \(3 rows\)/);
  });
});

// docker stop sends SIGTERM and kills after its timeout: a server that ignored the signal
// would take the full 10 seconds
describe("the Docker image on docker stop", () => {
  it("shuts down at once", async () => {
    const container = await serve();
    const start = Date.now();
    await container.stop({ timeout: 10_000 });
    assert.ok(Date.now() - start < 5_000, `took ${Date.now() - start} ms`);
  });
});
