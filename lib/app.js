// Builds the Express app: one model, one store, and a V2 and/or V4 service on top of it.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { parseMetadata, emitV2, emitV4 } = require("./metadata");
const { Store } = require("./store");
const { ODataService } = require("./service");
const { createBatchHandler } = require("./batch");
const protocols = {
  v2: require("./protocols/v2"),
  v4: require("./protocols/v4"),
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// options: { modelDir, v2Path, v4Path, log }. A falsy path disables that protocol.
function createApp({ modelDir, v2Path, v4Path, log = console.log }) {
  // Read input metadata file
  const metadataXml = fs.readFileSync(
    path.join(modelDir, "metadata.xml"),
    "utf8",
  );

  // Parse metadata file info
  const model = parseMetadata(metadataXml);

  log(
    `Model ${modelDir} (OData V${model.sourceVersion} document): ${Object.keys(model.entitySets).length} entity sets`,
  );
  for (const warning of model.warnings)
    log(`  navigation disabled: ${warning}`);

  // Instantiate storage
  const store = new Store(model, modelDir, log);

  // Whichever flavour the model was written in is served verbatim on that protocol's
  // $metadata; the other one is generated from the model.
  const metadata = {
    v2: model.sourceVersion === "2.0" ? metadataXml : emitV2(model),
    v4: model.sourceVersion === "4.0" ? metadataXml : emitV4(model),
  };

  const services = [];
  for (const [name, servicePath] of [
    ["v2", v2Path],
    ["v4", v4Path],
  ]) {
    if (!servicePath) continue;
    services.push(
      new ODataService({
        model,
        store,
        protocol: protocols[name],
        servicePath: servicePath.replace(/\/+$/, ""),
        metadataXml: metadata[name],
      }),
    );
  }

  const app = express();
  app.disable("x-powered-by");

  // Allow calling the service from a locally-served UI5 app during development.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Methods",
      "GET,HEAD,POST,PUT,MERGE,PATCH,DELETE,OPTIONS",
    );
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type,Accept,X-Requested-With,X-CSRF-Token,OData-Version,OData-MaxVersion,Prefer,If-Match,Content-ID",
    );
    res.header(
      "Access-Control-Expose-Headers",
      "X-CSRF-Token,OData-Version,DataServiceVersion,Location,Preference-Applied,ETag",
    );
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // UI5 fetches a CSRF token before write requests; a fixed dummy token is enough for a mock.
  app.use((req, res, next) => {
    if (req.headers["x-csrf-token"] === "Fetch")
      res.header("X-CSRF-Token", "mock-csrf-token");
    next();
  });

  app.get("/healthz", (req, res) => res.status(200).send("ok"));

  app.get("/", (req, res) =>
    res.json({
      model: path.basename(modelDir),
      services: services.map((s) => ({
        odataVersion: s.protocol.version,
        root: `${s.servicePath}/`,
      })),
    }),
  );

  // $batch bodies are multipart and must stay raw; everything else is JSON.
  for (const service of services) {
    app.post(
      new RegExp(`^${escapeRegex(service.servicePath)}/\\$batch$`),
      express.raw({ type: () => true, limit: "10mb" }),
      createBatchHandler(service),
    );
  }

  app.use(
    express.json({ type: ["application/json", "text/plain"], limit: "10mb" }),
  );

  function sendResult(res, service, result) {
    res.set(service.protocol.headers);
    if (result.headers) res.set(result.headers);
    if (result.status === 204 || result.body === undefined)
      return res.status(result.status).send();
    // setHeader + end rather than res.type()/res.send(): express would lowercase the
    // parameters and append a charset, and UI5 looks for IEEE754Compatible=true in the
    // response Content-Type as is.
    res
      .status(result.status)
      .setHeader("Content-Type", result.contentType || "application/json");
    return res.end(
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body),
    );
  }

  // Express treats "$", "(" and ")" specially in string patterns, so match on a prefix
  // regex and let the service parse the rest of the path itself.
  for (const service of services) {
    app.all(
      new RegExp(`^${escapeRegex(service.servicePath)}(/|$)`),
      (req, res) => {
        sendResult(
          res,
          service,
          service.dispatch(
            // HEAD is GET without a body (Node drops the body itself). UI5 sends
            // HEAD to the service root, e.g. to fetch a CSRF token.
            req.method === "HEAD" ? "GET" : req.method,
            decodeURI(req.path),
            req.query,
            req.body,
            req.headers,
          ),
        );
      },
    );
  }

  return { app, model, store, services };
}

module.exports = { createApp };
