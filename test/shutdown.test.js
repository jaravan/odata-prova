import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { PO_MODEL } from "./helpers.js";

// In a container the server is PID 1; without a SIGTERM handler Docker and Kubernetes wait out
// their grace period (10s / 30s) before killing it. It must exit by itself, and cleanly.
describe(
  "shutdown",
  { skip: process.platform === "win32" && "Windows has no SIGTERM" },
  () => {
    it("exits with 0 shortly after SIGTERM", async () => {
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dirname, "..", "server.js"), PO_MODEL],
        {
          env: { ...process.env, PORT: "0" },
        },
      );
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));

      const port = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`server did not start:\n${output}`)),
          10000,
        );
        child.stdout.on("data", () => {
          const m = output.match(/listening on port (\d+)/);
          if (m) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
      });
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/healthz`)).status,
        200,
      );

      const started = Date.now();
      child.kill("SIGTERM");
      const code = await new Promise((resolve) => child.on("exit", resolve));

      assert.equal(code, 0, output);
      assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
      assert.match(output, /SIGTERM received, shutting down/);
    });
  },
);
