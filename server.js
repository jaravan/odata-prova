// Metadata-driven OData server that serves V2 and V4 at the same time

const path = require("path");
const { createApp } = require("./lib/app");

const PORT = process.env.PORT || 3000;
const MODEL_DIR = path.resolve(
  process.env.MODEL_DIR || path.join(__dirname, "model", "PurchaseOrderSrv"),
);
const SERVICE_NAME = process.env.SERVICE_NAME || path.basename(MODEL_DIR);

// Set to an empty string to switch the specific protocol off
const V2_PATH = process.env.V2_PATH ?? `/odata/v2/${SERVICE_NAME}`;
const V4_PATH = process.env.V4_PATH ?? `/odata/v4/${SERVICE_NAME}`;

function exitWithError(context, err) {
  console.error(`OData server failed to start: ${context}`);
  // System errors (ENOENT, EADDRINUSE, ...) are self-explanatory, show stack for everything else
  console.error(err.code ? err.message : err.stack);
  process.exit(1);
}

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
app.listen(PORT, (err) => {
  if (err) exitWithError(`cannot listen on port ${PORT}`, err);
  console.log(`OData server listening on port ${PORT}`);
});
