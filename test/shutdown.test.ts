import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { PO_MODEL } from "./helpers.ts";

// The server on PO_MODEL, on a free port, with env, once it listens
async function serve(env: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "..", "server.ts"), PO_MODEL],
    { env: { ...process.env, PORT: "0", ...env } },
  );
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const port = await new Promise<string>((resolve, reject) => {
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
  return { child, port, output: () => output };
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => child.on("exit", resolve));

// In a container the server is PID 1; without a SIGTERM handler Docker and Kubernetes wait out
// their grace period (10s / 30s) before killing it. It must exit by itself, and cleanly.
describe(
  "shutdown",
  { skip: process.platform === "win32" && "Windows has no SIGTERM" },
  () => {
    it("exits with 0 shortly after SIGTERM", async () => {
      const { child, port, output } = await serve();
      assert.equal(
        (await fetch(`http://127.0.0.1:${port}/healthz`)).status,
        200,
      );

      const started = Date.now();
      child.kill("SIGTERM");
      const code = await exited(child);

      // 0: it closed by itself, before its own 10-second deadline, which exits with 1. The
      // time only has to be well inside a container's grace period, with room for a slow
      // CI runner under coverage.
      assert.equal(code, 0, output());
      assert.ok(Date.now() - started < 8000, `took ${Date.now() - started} ms`);
      assert.match(output(), /SIGTERM received, shutting down\n/);
    });

    it("with SHUTDOWN_DELAY, answers until it's over, asking clients to reconnect", async () => {
      const { child, port, output } = await serve({ SHUTDOWN_DELAY: "1000" });
      const started = Date.now();
      child.kill("SIGTERM");
      await sleep(300);
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("connection"), "close");
      assert.equal(await exited(child), 0, output());
      assert.ok(
        Date.now() - started >= 1000,
        `took ${Date.now() - started} ms`,
      );
      assert.match(output(), /SIGTERM received, shutting down in 1s/);
    });

    it("waits 5 seconds by default in Kubernetes", async () => {
      const { child, output } = await serve({
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
      });
      child.kill("SIGTERM");
      await sleep(300);
      assert.match(output(), /SIGTERM received, shutting down in 5s/);
      child.kill("SIGKILL");
      await exited(child);
    });
  },
);
