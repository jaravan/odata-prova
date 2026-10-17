import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
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

// Starts it, and resolves with the port it listens on, then stops it
async function listeningPort(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [SERVER, ...args], {
    env: { ...process.env, ...env },
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  try {
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`did not start:\n${output}`)),
        10000,
      );
      child.stdout.on("data", () => {
        const m = output.match(/listening on port (\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    });
  } finally {
    child.kill();
  }
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
      /bad port\nthe port must be a number from 0 to 65535, got '70000'/,
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
});
