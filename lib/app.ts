// Builds the Express app: one model, one store, and a V2 and/or V4 service on top of it.
import express from "express";
import type { ErrorRequestHandler, Express, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { parseMetadata } from "./metadata.ts";
import { emitV2 } from "./emit-v2.ts";
import { emitV4 } from "./emit-v4.ts";
import { Store } from "./store.ts";
import { ODataService } from "./service.ts";
import { Queue } from "./queue.ts";
import {
  open,
  sharedTurn,
  LostError,
  type Persistence,
} from "./persistence.ts";
import { SqlitePersistence } from "./sqlite.ts";
import { PostgresPersistence, isPostgresUrl } from "./postgres.ts";
import type { Protocol, Rules } from "./protocol.ts";
import { configError, loadConfig, type Config } from "./config.ts";
import { resolveMockRules } from "./mock-rules.ts";
import type { Model, ODataResponse } from "./model.ts";
import { createBatchHandler } from "./batch.ts";
import { ETAG_MODES } from "./etag.ts";
import type { ETagMode } from "./etag.ts";
import { JOIN_MODES } from "./navigations.ts";
import type { JoinMode } from "./navigations.ts";
import { HttpError, decodeUrl } from "./query.ts";
import v2 from "./protocols/v2.ts";
import v4 from "./protocols/v4.ts";

const protocols: Record<"v2" | "v4", Protocol> = { v2, v4 };

// MODEL_DIR is either a model folder (it has a metadata.xml) or a folder holding exactly
// one model folder. Kubernetes uses the second form: the model image decides the name.
function findModelDir(dir: string): string {
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
  throw Object.assign(
    new Error(
      models.length
        ? `${dir} holds ${models.length} models (${models.join(", ")}): point MODEL_DIR at one of them`
        : `${dir} has no metadata.xml and no model folder`,
    ),
    { code: "ENOMODEL" }, // a plain message at startup, not a stack trace
  );
}

// config.json's operations (see config.ts): { "<Name>": { "set": { "<Prop>": value } } } sets
// properties on the entity an operation acts on (Approve sets Status to Approved).
// Validated at startup, so a typo fails there instead of never applying.
function operationRules(model: Model, config: Config): Rules {
  const rules = config.operations;
  const views = Object.values(model.operationViews);
  for (const [name, { file, ...rule }] of Object.entries(rules)) {
    // The entity type the operation acts on, from whichever protocol has it
    const type = views
      .flatMap((v) => [...v.bound, ...Object.values(v.imports)])
      .filter((op) => op.name === name)
      .map((op) => op.binding?.entityType || op.bindsTo?.type)
      .find(Boolean);
    if (!type)
      throw configError(
        `${file}: operations.${name}: no operation of that name acts on an entity`,
      );
    for (const prop of Object.keys(rule.set || {}))
      if (!type.properties[prop])
        throw configError(
          `${file}: operations.${name}.set: ${type.name} has no property ${prop}`,
        );
  }
  return Object.fromEntries(
    Object.entries(rules).map(([name, { set }]) => [name, { set }]),
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface AppOptions {
  // The folder with metadata.xml, and data/ and config.json if any
  modelDir: string;
  // Where each protocol is served; a falsy path disables it
  v2Path?: string;
  v4Path?: string;
  log?: (message: string) => void;
  // Rows to generate for each entity set without a seed file (0, the default: none)
  mockRows?: number;
  // How strictly If-Match is checked (see etag.ts): lenient, the default, strict or off
  etags?: ETagMode;
  // How a navigation without a ReferentialConstraint is joined (see navigations.ts): guess,
  // the default, or strict
  joins?: JoinMode;
  // The most rows a collection's response holds, with a next link to the rest (server-driven
  // paging, see service.ts); 0, the default: every row
  pageSize?: number;
  // Where the data is kept, so writes survive a restart: a SQLite file (created if there's
  // none), or a postgres:// URL (see postgres.ts); none: in memory only
  persist?: string;
  // With persist: replace what was saved with the seed data, rather than load it
  persistReset?: boolean;
  // Whose rows they are in a database persist names, which other services may use too: the
  // model folder's name, by default
  serviceName?: string;
  // What saves each commit, instead of persist's file (see persistence.ts): for the tests
  persistence?: Persistence;
}

function createApp({
  modelDir,
  v2Path,
  v4Path,
  log = console.log,
  mockRows = 0,
  etags = "lenient",
  joins = "guess",
  pageSize = 0,
  persist,
  persistReset = false,
  serviceName = path.basename(path.resolve(modelDir)),
  persistence = !persist
    ? undefined
    : isPostgresUrl(persist)
      ? new PostgresPersistence(persist, serviceName)
      : new SqlitePersistence(persist),
}: AppOptions): {
  app: Express;
  model: Model;
  store: Store;
  services: ODataService[];
  // Settles once requests can be answered: rejected when the saved state couldn't be loaded
  ready: Promise<void>;
  close: () => Promise<void>;
} {
  // Read input metadata file
  const metadataXml = fs.readFileSync(
    path.join(modelDir, "metadata.xml"),
    "utf8",
  );

  // Parse metadata file info
  const model = parseMetadata(metadataXml, { joins });

  log(
    `Model ${modelDir} (OData V${model.sourceVersion} document): ${Object.keys(model.entitySets).length} entity sets`,
  );
  for (const warning of model.warnings) log(`  ${warning}`);
  const drafts = Object.values(model.entitySets).filter((es) => es.draft);
  if (drafts.length)
    log(
      `  draft-enabled: ${drafts.map((es) => (es.draft?.root ? `${es.name} (root)` : es.name)).join(", ")}`,
    );
  const config = loadConfig(modelDir);
  const rules = operationRules(model, config);
  // Checked at startup, a mistake stopping it with how to fix it
  const mockRules = resolveMockRules(model, config.mock, mockRows);

  // Instantiate storage
  const store = new Store(model, modelDir, log, { mockRows, mockRules });

  // Whichever flavour the model was written in is served verbatim on that protocol's
  // $metadata; the other one is generated from the model.
  const metadata = {
    v2: model.sourceVersion === "2.0" ? metadataXml : emitV2(model),
    v4: model.sourceVersion === "4.0" ? metadataXml : emitV4(model),
  };

  // One queue for every service on the store (see queue.ts). With persistence, the saved state
  // replaces the seeded one first, or the seeded one is saved: requests wait for that.
  const ready = persistence
    ? open(persistence, store, log, { reset: persistReset })
    : Promise.resolve();
  // A backend several servers share catches the store up with what the others saved, first
  const shared = persistence?.since ? persistence : undefined;
  // Set when the saved state is gone (see LostError): /healthz fails from then on, for a
  // liveness probe to restart the server
  let lost: Error | undefined;
  const queue = new Queue(
    ready,
    shared &&
      (async (task, writes) => {
        try {
          return await sharedTurn(shared, store, task, writes);
        } catch (e) {
          if (e instanceof LostError) lost = e;
          throw e;
        }
      }),
  );
  const services: ODataService[] = [];
  for (const [name, servicePath] of [
    ["v2", v2Path],
    ["v4", v4Path],
  ] as const) {
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
        etags,
        pageSize,
        queue,
        persistence,
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
    // Whatever headers the preflight asks for: clients send their own (UI5's V2 model sends
    // sap-cancel-on-close, sap-contextid-accept and MaxDataServiceVersion), and a refused
    // one fails the request
    res.header(
      "Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] ||
        "Content-Type,Accept,X-Requested-With,X-CSRF-Token,OData-Version,OData-MaxVersion,Prefer,If-Match,Content-ID",
    );
    res.vary("Access-Control-Request-Headers");
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

  app.get("/healthz", (req, res) =>
    lost ? res.status(503).send(lost.message) : res.status(200).send("ok"),
  );

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

  function sendResult(
    res: Response,
    protocol: Protocol,
    result: ODataResponse,
  ) {
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
      async (req, res) => {
        sendResult(
          res,
          service.protocol,
          await service.dispatch(
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
  // err: an HttpError, or an Error from Express or body-parser, which sets status and
  // expose (true for a client error)
  const onError: ErrorRequestHandler = (
    err: Error & { status?: number; expose?: boolean },
    req,
    res,
    next,
  ) => {
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
    const code = err instanceof HttpError ? err.code : undefined;
    sendResult(res, protocol, protocol.error(status ?? 500, err.message, code));
  };
  app.use(onError);

  // Once every request so far has been answered and saved: closes persistence
  async function close(): Promise<void> {
    await queue.idle();
    await persistence?.close();
  }

  return { app, model, store, services, ready, close };
}

export type { ETagMode, JoinMode };
export { createApp, findModelDir, ETAG_MODES, JOIN_MODES };
