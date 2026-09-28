// Metadata-driven OData server that serves V2 and V4 at the same time

const path = require("path");
const { createApp, findModelDir } = require("./lib/app");

const PORT = process.env.PORT || 3000;
// Models live outside the server, in the repo's models/ folder. The image sets
// MODEL_DIR=/models instead, and findModelDir picks the one model mounted there.
let MODEL_DIR = path.resolve(
  process.env.MODEL_DIR ||
    path.join(__dirname, "..", "models", "PurchaseOrderSrv"),
);

function exitWithError(context, err) {
  console.error(`OData server failed to start: ${context}`);
  // System errors (ENOENT, EADDRINUSE, ...) are self-explanatory, show stack for everything else
  console.error(err.code ? err.message : err.stack);
  process.exit(1);
}

try {
  MODEL_DIR = findModelDir(MODEL_DIR);
} catch (err) {
  exitWithError("cannot find the model", err);
}
const SERVICE_NAME = process.env.SERVICE_NAME || path.basename(MODEL_DIR);

// Set to an empty string to switch the specific protocol off
const V2_PATH = process.env.V2_PATH ?? `/odata/v2/${SERVICE_NAME}`;
const V4_PATH = process.env.V4_PATH ?? `/odata/v4/${SERVICE_NAME}`;

let app;
try {
  ({ app } = createApp({
    modelDir: MODEL_DIR,
    v2Path: V2_PATH,
    v4Path: V4_PATH,
  }));
} catch (err) {
  exitWithError(`cannot load model from ${MODEL_DIR}`, err);
}

// Express 5 passes listen errors (eg port in use) to callback instead of throwing
const server = app.listen(PORT, (err) => {
  if (err) exitWithError(`cannot listen on port ${PORT}`, err);
  console.log(`OData server listening on port ${server.address().port}`);
});

// As PID 1 in a container, Node ignores SIGTERM unless handled, so Docker and Kubernetes
// would wait out their grace period before killing it. Stop taking connections, let open
// requests finish, then exit; give up after 10 seconds.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
