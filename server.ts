#!/usr/bin/env node
// Mock OData server that serves a metadata.xml as V2 and V4 at the same time
//
//   odata-prova [modelDir] [options]      (default: the current directory; see USAGE)

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { createApp, findModelDir, ETAG_MODES, JOIN_MODES } from "./lib/app.ts";
import type { ETagMode, JoinMode } from "./lib/app.ts";

const USAGE = `Usage: odata-prova [modelDir] [options]

Serves the metadata.xml in modelDir (default: the current directory) as OData V2 and V4.

Options (default):
  -p, --port <port>          HTTP port (3000)
      --service-name <name>  The name in the default paths (the model folder's)
      --v2-path <path>       V2 service root (/odata/v2/<name>), "" to switch V2 off
      --v4-path <path>       V4 service root (/odata/v4/<name>), "" to switch V4 off
      --mock-rows <n>        Rows generated for each entity set without a data file (20)
      --page-size <n>        The most rows in a response, with a link to the rest (0: all)
      --etags <mode>         lenient, strict or off (lenient)
      --joins <mode>         guess or strict (guess)
  -h, --help                 Show this help
  -v, --version              Show the version

Each option can also be set with its environment variable instead: --mock-rows with
MOCK_ROWS, and so on, and modelDir with MODEL_DIR. The option wins.
See https://github.com/jaravan/odata-prova#configuration`;

// Each setting's option and the environment variable it falls back to
const SETTINGS = {
  port: "PORT",
  "service-name": "SERVICE_NAME",
  "v2-path": "V2_PATH",
  "v4-path": "V4_PATH",
  "mock-rows": "MOCK_ROWS",
  "page-size": "PAGE_SIZE",
  etags: "ETAGS",
  joins: "JOINS",
} as const;
type Setting = keyof typeof SETTINGS;

// Options work in every shell, where PORT=4004 npx ... doesn't (Windows' cmd and PowerShell)
let args: ReturnType<typeof readArgs>;
function readArgs() {
  return parseArgs({
    allowPositionals: true,
    options: {
      ...(Object.fromEntries(
        Object.keys(SETTINGS).map((name) => [name, { type: "string" }]),
      ) as Record<Setting, { type: "string" }>),
      port: { type: "string", short: "p" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
try {
  args = readArgs();
  if (args.positionals.length > 1)
    throw new Error(
      `one model folder at a time, got ${args.positionals.join(", ")}`,
    );
} catch (err) {
  const e = err as Error & { code?: string };
  // Node's message for it goes on about positional arguments
  const message =
    e.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
      ? `unknown option ${/'([^']+)'/.exec(e.message)?.[1] ?? ""}`
      : e.message;
  console.error(`odata-prova: ${message}\n\n${USAGE}`);
  process.exit(1);
}
if (args.values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (args.values.version) {
  console.log(packageVersion());
  process.exit(0);
}

// package.json is next to server.ts, or one folder up from the built dist/server.js
function packageVersion(): string {
  for (const dir of [import.meta.dirname, path.dirname(import.meta.dirname)]) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file))
      return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string })
        .version;
  }
  return "unknown";
}

// A setting's value: its option, else its environment variable, else undefined. An empty
// one counts (--v2-path "" switches V2 off).
function setting(name: Setting): string | undefined {
  return args.values[name] ?? process.env[SETTINGS[name]];
}

// A bad value stops the server, with a message naming the option or variable it came from
function badSetting(name: Setting, message: string): never {
  const from = args.values[name] !== undefined ? `--${name}` : SETTINGS[name];
  // a code: a plain message, not a stack trace
  exitWithError(
    `bad ${from}`,
    Object.assign(new Error(`${from} ${message}`), { code: "ESETTING" }),
  );
}

// 0 takes any free port, which the startup log shows
const PORT_TEXT = setting("port") ?? "3000";
const PORT = Number(PORT_TEXT);
if (!/^\d+$/.test(PORT_TEXT) || PORT > 65535)
  badSetting("port", `must be a number from 0 to 65535, got '${PORT_TEXT}'`);

// The model to serve: the argument, else MODEL_DIR (the image sets /models), else the
// current directory. findModelDir picks the one model in a folder that holds only one.
let MODEL_DIR = path.resolve(
  args.positionals[0] || process.env.MODEL_DIR || ".",
);

function exitWithError(context: string, err: unknown): never {
  const e = err as Error & { code?: string };
  console.error(`odata-prova failed to start: ${context}`);
  // System errors (ENOENT, EADDRINUSE, ...) are self-explanatory, show stack for everything else
  console.error(e.code ? e.message : e.stack);
  process.exit(1);
}

try {
  MODEL_DIR = findModelDir(MODEL_DIR);
} catch (err) {
  exitWithError("cannot find the model", err);
}
const SERVICE_NAME = setting("service-name") || path.basename(MODEL_DIR);

// Set to an empty string to switch the specific protocol off
const V2_PATH = setting("v2-path") ?? `/odata/v2/${SERVICE_NAME}`;
const V4_PATH = setting("v4-path") ?? `/odata/v4/${SERVICE_NAME}`;

// A setting that takes a whole number; anything else stops the server
function wholeNumber(name: Setting, fallback: number): number {
  const text = setting(name);
  const value = Number(text ?? fallback);
  if (!Number.isInteger(value) || value < 0)
    badSetting(name, `must be a whole number, got '${text}'`);
  return value;
}

// Rows generated for each entity set that has no seed file; 0 leaves those sets empty
const MOCK_ROWS = wholeNumber("mock-rows", 20);

// The most rows a collection's response holds, with a next link to the rest; 0 sends every row
const PAGE_SIZE = wholeNumber("page-size", 0);

// A setting that takes one of a few values; an unknown one stops the server
function choice<T extends string>(
  name: Setting,
  values: readonly T[],
  fallback: T,
): T {
  const value = (setting(name) || fallback) as T;
  if (!values.includes(value))
    badSetting(name, `must be one of ${values.join(", ")}, got '${value}'`);
  return value;
}

// How strictly If-Match is checked: lenient (a request without one goes through), strict
// (an update or delete without one is a 428) or off (it's ignored)
const ETAGS = choice<ETagMode>("etags", ETAG_MODES, "lenient");

// How a navigation without a ReferentialConstraint is joined: guess (by naming convention)
// or strict (never guessed: it gets a key or link set of its own, see navigations.ts)
const JOINS = choice<JoinMode>("joins", JOIN_MODES, "guess");

let app: Express;
try {
  ({ app } = createApp({
    modelDir: MODEL_DIR,
    v2Path: V2_PATH,
    v4Path: V4_PATH,
    mockRows: MOCK_ROWS,
    etags: ETAGS,
    joins: JOINS,
    pageSize: PAGE_SIZE,
  }));
} catch (err) {
  exitWithError(`cannot load model from ${MODEL_DIR}`, err);
}

// Express 5 passes listen errors (eg port in use) to callback instead of throwing
const server = app.listen(PORT, (err) => {
  if (err)
    exitWithError(
      (err as Error & { code?: string }).code === "EADDRINUSE"
        ? `port ${PORT} is in use: pick another with --port, eg --port 4004 (or PORT=4004)`
        : `cannot listen on port ${PORT}`,
      err,
    );
  const { port } = server.address() as AddressInfo;
  console.log(`odata-prova listening on port ${port}`);
  if (V2_PATH) console.log(`  V2: http://localhost:${port}${V2_PATH}/`);
  if (V4_PATH) console.log(`  V4: http://localhost:${port}${V4_PATH}/`);
});

// As PID 1 in a container, Node ignores SIGTERM unless handled, so Docker and Kubernetes
// would wait out their grace period before killing it. Stop taking connections, let open
// requests finish, then exit; give up after 10 seconds.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
