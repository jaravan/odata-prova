import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PO_MODEL } from "./helpers.ts";

// The odata-prova command itself: its flags, and what it says when it can't start
const SERVER = path.join(import.meta.dirname, "..", "server.ts");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [SERVER, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10000,
  });

// Starts it: the port it listens on, what it has printed so far, and a way to stop it
async function started(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    env: { ...process.env, ...env },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`did not start:\n${output}`));
    }, 10000);
    child.stdout.on("data", () => {
      const m = output.match(/listening on port (\d+)/);
      if (!m) return;
      clearTimeout(timer);
      // The service URLs follow the line, in the same tick
      setTimeout(() => resolve(Number(m[1])), 100);
    });
  });
  return { port, output: () => output, stop: () => child.kill() };
}

// Starts it, and resolves with the port it listens on, then stops it
async function listeningPort(args: string[], env: Record<string, string> = {}) {
  const s = await started(args, env);
  s.stop();
  return s.port;
}

describe("the odata-prova command", () => {
  it("--help and --version, -h and -v", () => {
    for (const flag of ["--help", "-h"]) {
      const r = run([flag]);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^Usage: odata-prova \[modelDir\] \[options\]/);
      assert.match(r.stdout, /-p, --port <port>/);
    }
    const { version } = JSON.parse(
      fs.readFileSync(
        path.join(import.meta.dirname, "..", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    for (const flag of ["--version", "-v"])
      assert.equal(run([flag]).stdout.trim(), version);
  });

  it("--port, before or after the model folder, over PORT", async () => {
    // A free port: listen on 0, note it, and let it go again
    const free = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    assert.equal(
      await listeningPort([PO_MODEL, "--port", String(free)], { PORT: "1" }),
      free,
    );
    assert.equal((await listeningPort(["-p", "0", PO_MODEL])) > 0, true);
  });

  it("a mistake on the command line: a message and the usage, exit 1", () => {
    for (const [args, message] of [
      [["--nope"], /^odata-prova: unknown option --nope\n\nUsage:/],
      [["a", "b"], /one model folder at a time, got a, b/],
      [["--port"], /argument missing/],
    ] as const) {
      const r = run([...args]);
      assert.equal(r.status, 1, args.join(" "));
      assert.match(r.stderr, message, args.join(" "));
    }
    const bad = run([PO_MODEL, "--port", "70000"]);
    assert.equal(bad.status, 1);
    assert.match(
      bad.stderr,
      /bad --port\n--port must be a number from 0 to 65535, got '70000'/,
    );
  });

  it("a port in use: says to pick another", async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, resolve));
    const { port } = taken.address() as net.AddressInfo;
    try {
      const r = run([PO_MODEL, "--port", String(port)]);
      assert.equal(r.status, 1);
      assert.match(
        r.stderr,
        new RegExp(
          `port ${port} is in use: pick another with --port, eg --port 4004 \\(or PORT=4004\\)`,
        ),
      );
    } finally {
      taken.close();
    }
  });

  it("every setting has an option, which wins over its environment variable", async () => {
    // A copy of the model without its data files, so mock rows fill it
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"));
    fs.copyFileSync(
      path.join(PO_MODEL, "metadata.xml"),
      path.join(dir, "metadata.xml"),
    );
    const s = await started(
      [
        dir,
        "--port=0",
        "--service-name",
        "Orders",
        "--v2-path",
        "",
        "--mock-rows",
        "3",
        "--page-size",
        "2",
        "--etags",
        "strict",
        "--joins",
        "strict",
      ],
      { MOCK_ROWS: "9", PAGE_SIZE: "9", V4_PATH: "/ignored" },
    );
    try {
      const base = `http://127.0.0.1:${s.port}`;
      // --v4-path wasn't given, so V4_PATH is taken; --v2-path "" switches V2 off
      assert.match(s.output(), /V4: http:\/\/localhost:\d+\/ignored\//);
      assert.doesNotMatch(s.output(), /V2:/);
      const first = await (
        await fetch(`${base}/ignored/PurchaseOrderSet`)
      ).json();
      assert.equal(first.value.length, 2); // --page-size 2
      assert.ok(first["@odata.nextLink"]);
      const all = await (
        await fetch(`${base}/ignored/PurchaseOrderSet/$count`)
      ).text();
      assert.equal(all, "3"); // --mock-rows 3
      assert.equal(
        (await fetch(`${base}/odata/v2/Orders/PurchaseOrderSet`)).status,
        404,
      );
    } finally {
      s.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // --service-name names the default paths
    const named = await started([
      PO_MODEL,
      "--port",
      "0",
      "--service-name",
      "Orders",
    ]);
    named.stop();
    assert.match(
      named.output(),
      /V2: http:\/\/localhost:\d+\/odata\/v2\/Orders\//,
    );
  });

  it("a bad value is named as it was given: the option or the variable", () => {
    for (const [args, env, message] of [
      [
        ["--mock-rows", "abc"],
        {},
        /bad --mock-rows\n--mock-rows must be a whole number, got 'abc'/,
      ],
      [
        [],
        { MOCK_ROWS: "-1" },
        /bad MOCK_ROWS\nMOCK_ROWS must be a whole number, got '-1'/,
      ],
      [["--page-size", "1.5"], {}, /--page-size must be a whole number/],
      [
        ["--etags", "nope"],
        {},
        /--etags must be one of lenient, strict, off, got 'nope'/,
      ],
      [
        ["--joins", "nope"],
        { JOINS: "guess" },
        /--joins must be one of guess, strict/,
      ],
      [["--port=-1"], {}, /bad --port\n--port must be a number/],
    ] as const) {
      const r = run([PO_MODEL, ...args], env);
      assert.equal(r.status, 1, args.join(" "));
      assert.match(r.stderr, message, args.join(" "));
    }
  });
});
