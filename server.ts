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
import { isPostgresUrl } from "./lib/postgres.ts";
import { writeMockData } from "./lib/mock-data.ts";
import { explain, fillerCount } from "./lib/explain.ts";

const USAGE = `Usage: odata-prova [modelDir] [options]

Serves the metadata.xml in modelDir (default: the current directory) as OData V2 and V4.

Options (default):
  -p, --port <port>          HTTP port (3000)
      --service-name <name>  The name in the default paths (the model folder's)
      --v2-path <path>       V2 service root (/odata/v2/<name>), "" to switch V2 off
      --v4-path <path>       V4 service root (/odata/v4/<name>), "" to switch V4 off
      --mock-rows <n>        Rows generated for each entity set without a data file (20);
                             items, 1 to 5 under each parent
      --page-size <n>        The most rows in a response, with a link to the rest (0: all)
      --etags <mode>         lenient, strict or off (lenient)
      --joins <mode>         guess or strict (guess)
      --persist <file|url>   Keep the data in a SQLite file, or a PostgreSQL database
                             (postgres://...), so writes survive a restart
                             (none: in memory only, reset at every start)
      --persist-reset        Start over: replace what was saved with the seed data
      --explain [all]        Show the generated properties on filler values, and what to
                             add to config.json, then exit; all: every property
      --write-data           Write the generated rows to modelDir/data, to edit them, and
                             exit (--mock-rows of each); existing files are kept
  -h, --help                 Show this help
  -v, --version              Show the version

Each option can also be set with its environment variable instead: --mock-rows with
MOCK_ROWS, and so on, --persist-reset with PERSIST_RESET=1, and modelDir with MODEL_DIR.
The option wins.
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
  persist: "PERSIST",
} as const;
type Setting = keyof typeof SETTINGS;

// --persist with no value is in memory only, --explain with none is the short one: last, or
// before another option, each gets an empty one, as parseArgs would refuse it without (and
// would take "all" in --explain all for a second model folder, as a flag)
function bareFlags(argv: string[]): string[] {
  return argv.flatMap((arg, i) =>
    (arg === "--persist" || arg === "--explain") &&
    (i === argv.length - 1 || argv[i + 1].startsWith("-"))
      ? [arg, ""]
      : [arg],
  );
}

// Options work in every shell, where PORT=4004 npx ... doesn't (Windows' cmd and PowerShell)
let args: ReturnType<typeof readArgs>;
function readArgs() {
  return parseArgs({
    args: bareFlags(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      ...(Object.fromEntries(
        Object.keys(SETTINGS).map((name) => [name, { type: "string" }]),
      ) as Record<Setting, { type: "string" }>),
      port: { type: "string", short: "p" },
      "persist-reset": { type: "boolean" },
      "write-data": { type: "boolean" },
      explain: { type: "string" },
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

// The SQLite file, or the postgres:// URL, that keeps the data; none (or an empty value): in
// memory only. A folder is refused: `--persist ./MySrv` would otherwise take the model folder
// for the file. Checked before the model is looked for, which that mistake leaves without a
// folder.
const PERSIST_TEXT = setting("persist");
const PERSIST = !PERSIST_TEXT
  ? undefined
  : isPostgresUrl(PERSIST_TEXT)
    ? PERSIST_TEXT
    : path.resolve(PERSIST_TEXT);
if (PERSIST && fs.statSync(PERSIST, { throwIfNoEntry: false })?.isDirectory())
  badSetting(
    "persist",
    `is a folder, '${PERSIST_TEXT}': give the file to keep the data in, e.g. --persist ./MySrv.db (no value: in memory only)`,
  );
const PERSIST_RESET =
  args.values["persist-reset"] ??
  /^(1|true|yes)$/i.test(process.env.PERSIST_RESET ?? "");
if (PERSIST_RESET && !PERSIST)
  exitWithError(
    "bad --persist-reset",
    Object.assign(
      new Error(
        "--persist-reset needs --persist <file|url> (or PERSIST): there's no saved data to reset",
      ),
      { code: "ESETTING" },
    ),
  );

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

// --explain: how the generated rows are made, and what to add to config.json, instead of
// serving them; --explain all: every property
const EXPLAIN = args.values.explain;
if (EXPLAIN !== undefined) {
  if (EXPLAIN !== "" && EXPLAIN !== "all")
    exitWithError(
      "bad --explain",
      Object.assign(
        new Error(`--explain takes nothing, or all, got '${EXPLAIN}'`),
        { code: "ESETTING" },
      ),
    );
  try {
    console.log(explain(MODEL_DIR, MOCK_ROWS, EXPLAIN === "all"));
  } catch (err) {
    exitWithError("cannot explain the model", err);
  }
  process.exit(0);
}

// --write-data: the generated rows into data/, to edit them, instead of serving them
if (args.values["write-data"]) {
  if (!MOCK_ROWS)
    badSetting("mock-rows", "is 0: --write-data would write nothing");
  try {
    const written = writeMockData(MODEL_DIR, MOCK_ROWS);
    if (!written.length)
      console.log("Every entity set already has a data file, nothing to write");
    for (const { file, rows } of written)
      console.log(`wrote ${file} (${rows} rows)`);
  } catch (err) {
    exitWithError("cannot write the data", err);
  }
  process.exit(0);
}

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
let ready: Promise<void>;
let close: () => Promise<void>;
// In Kubernetes, a pod leaves its Service's endpoints while it's told to stop, not before: for
// a few seconds more, requests still come to it. It keeps answering them, asking each client to
// reconnect (Connection: close), so that the next goes to another pod. Elsewhere it stops at
// once. SHUTDOWN_DELAY (ms) sets it.
const DELAY_TEXT =
  process.env.SHUTDOWN_DELAY ??
  (process.env.KUBERNETES_SERVICE_HOST ? "5000" : "0");
const SHUTDOWN_DELAY = Number(DELAY_TEXT);
if (!/^\d+$/.test(DELAY_TEXT))
  exitWithError(
    "bad SHUTDOWN_DELAY",
    Object.assign(
      new Error(`SHUTDOWN_DELAY must be a number of ms, got '${DELAY_TEXT}'`),
      { code: "ESETTING" },
    ),
  );
// Generated properties on filler values: one line says so, and how to see them
let fillers = 0;
try {
  const built = createApp({
    modelDir: MODEL_DIR,
    v2Path: V2_PATH,
    v4Path: V4_PATH,
    mockRows: MOCK_ROWS,
    etags: ETAGS,
    joins: JOINS,
    pageSize: PAGE_SIZE,
    persist: PERSIST,
    persistReset: PERSIST_RESET,
    serviceName: SERVICE_NAME,
    // Without persistence, a change to the mock rules shows at once (see live-rules.ts)
    watchRules: !PERSIST,
  });
  ({ app, ready, close } = built);
  if (MOCK_ROWS) fillers = fillerCount(built.model, built.store, MODEL_DIR);
} catch (err) {
  exitWithError(`cannot load model from ${MODEL_DIR}`, err);
}
if (fillers)
  console.log(
    `  ${fillers === 1 ? "1 property uses" : `${fillers} properties use`} filler values: add --explain to see them, and what to put in config.json`,
  );

// The saved state, when there is persistence: requests can't be answered without it
try {
  await ready;
} catch (err) {
  exitWithError("cannot load the saved state", err);
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

// See SHUTDOWN_DELAY
let draining = false;
server.prependListener("request", (_req, res) => {
  if (draining) res.setHeader("Connection", "close");
});

// As PID 1 in a container, Node ignores SIGTERM unless handled, so Docker and Kubernetes
// would wait out their grace period before killing it. After SHUTDOWN_DELAY, stop taking
// connections, let open requests finish, then exit; give up 10 seconds later.
function shutdown(signal: string): void {
  console.log(
    `${signal} received, shutting down${SHUTDOWN_DELAY ? ` in ${SHUTDOWN_DELAY / 1000}s` : ""}`,
  );
  draining = true;
  setTimeout(() => {
    // Once the open requests are answered, and what they changed is saved
    server.close(() => {
      void close().then(
        () => process.exit(0),
        (err: unknown) => {
          console.error("odata-prova: cannot close persistence", err);
          process.exit(1);
        },
      );
    });
    server.closeIdleConnections();
  }, SHUTDOWN_DELAY);
  setTimeout(() => process.exit(1), SHUTDOWN_DELAY + 10000).unref();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
