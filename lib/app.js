// Builds the Express app: one model, one store, and a V2 and/or V4 service on top of it.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { parseMetadata, emitV2, emitV4 } from "./metadata.ts";
import { Store } from "./store.ts";
import { ODataService } from "./service.ts";
import { createBatchHandler } from "./batch.ts";
import { HttpError, decodeUrl } from "./query.ts";
import v2 from "./protocols/v2.js";
import v4 from "./protocols/v4.js";

const protocols = { v2, v4 };

// MODEL_DIR is either a model folder (it has a metadata.xml) or a folder holding exactly
// one model folder. Kubernetes uses the second form: the model image decides the name.
function findModelDir(dir) {
  if (fs.existsSync(path.join(dir, "metadata.xml")) || !fs.existsSync(dir))
    return dir;
  const models = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        fs.existsSync(path.join(dir, d.name, "metadata.xml")),
    )
    .map((d) => d.name)
    .sort(); // listing order depends on the filesystem
  if (models.length === 1) return path.join(dir, models[0]);
  const err = new Error(
    models.length
      ? `${dir} holds ${models.length} models (${models.join(", ")}): point MODEL_DIR at one of them`
      : `${dir} has no metadata.xml and no model folder`,
  );
  err.code = "ENOMODEL"; // a plain message at startup, not a stack trace
  throw err;
}

// Optional <modelDir>/config.json: { "operations": { "<Name>": { "set": { "<Prop>": value } } } }
// sets properties on the entity an operation acts on (Approve sets Status to Approved).
// Validated at startup, so a typo fails there instead of never applying.
function operationRules(model, modelDir) {
  const file = path.join(modelDir, "config.json");
  if (!fs.existsSync(file)) return {};
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
  const rules = config.operations || {};
  const views = Object.values(model.operationViews);
  for (const [name, rule] of Object.entries(rules)) {
    // The entity type the operation acts on, from whichever protocol has it
    const type = views
      .flatMap((v) => [...v.bound, ...Object.values(v.imports)])
      .filter((op) => op.name === name)
      .map((op) => op.binding?.entityType || op.bindsTo?.type)
      .find(Boolean);
    if (!type)
      throw new Error(
        `${file}: operations.${name}: no operation of that name acts on an entity`,
      );
    for (const prop of Object.keys(rule.set || {}))
      if (!type.properties[prop])
        throw new Error(
          `${file}: operations.${name}.set: ${type.name} has no property ${prop}`,
        );
  }
  return rules;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// options: { modelDir, v2Path, v4Path, log, mockRows }. A falsy path disables that protocol.
// mockRows: rows to generate for each entity set without a seed file (0, the default: none).
function createApp({
  modelDir,
  v2Path,
  v4Path,
  log = console.log,
  mockRows = 0,
}) {
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
  for (const warning of model.warnings) log(`  ${warning}`);
  const drafts = Object.values(model.entitySets).filter((es) => es.draft);
  if (drafts.length)
    log(
      `  draft-enabled: ${drafts.map((es) => (es.draft.root ? `${es.name} (root)` : es.name)).join(", ")}`,
    );
  const rules = operationRules(model, modelDir);

  // Instantiate storage
  const store = new Store(model, modelDir, log, { mockRows });

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
        log,
        rules,
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

  function sendResult(res, protocol, result) {
    res.set(protocol.headers);
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
          service.protocol,
          service.dispatch(
            // HEAD is GET without a body (Node drops the body itself). UI5 sends
            // HEAD to the service root, e.g. to fetch a CSRF token.
            req.method === "HEAD" ? "GET" : req.method,
            decodeUrl(req.path),
            req.query,
            req.body,
            req.headers,
          ),
        );
      },
    );
  }

  // Errors raised before the service sees the request: a malformed URL, a body that is not
  // JSON or is too large (express.json sets the status), or a bug. Answered in the error
  // format of the service the request was for, instead of Express's HTML page with a
  // stack trace.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err instanceof HttpError || err.expose ? err.status : 500;
    if (status === 500) console.error(err);
    const service =
      services.find(
        (s) =>
          req.path === s.servicePath ||
          req.path.startsWith(`${s.servicePath}/`),
      ) || services[0];
    const protocol = service?.protocol || protocols.v4;
    sendResult(res, protocol, protocol.error(status, err.message));
  });

  return { app, model, store, services };
}

export { createApp, findModelDir };
