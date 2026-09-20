const express = require("express");
const fs = require("fs");
const path = require("path");
const { parseMetadata, emitV2, emitV4 } = require("./metadata");

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

  // TODO: Set up OData V2/V4 services

  const app = express();
  app.disable("x-powered-by");

  // Allow calling the service from a locally-served UI5 app during development.
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,MERGE,PATCH,DELETE,OPTIONS",
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

  app.get(
    "/",
    // (req, res) => res.status(200).send("root path"),
    (req, res) =>
      res.json({
        model: path.basename(modelDir),
        //   services: services.map((s) => ({
        //     odataVersion: s.protocol.version,
        //     root: `${s.servicePath}/`,
        // })),
      }),
  );

  return { app };
}

module.exports = { createApp };
