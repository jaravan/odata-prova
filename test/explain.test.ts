import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { explain } from "../lib/explain.ts";
import { PO_MODEL } from "./helpers.ts";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
const NORTHWIND = path.join(FIXTURES, "real", "NorthwindV2");

// A copy of a model's metadata.xml in a temporary folder, with these files besides
function model(from: string, files: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "explain-"));
  const srv = path.join(dir, "Srv");
  fs.mkdirSync(srv);
  fs.copyFileSync(
    path.join(from, "metadata.xml"),
    path.join(srv, "metadata.xml"),
  );
  for (const [file, json] of Object.entries(files))
    fs.writeFileSync(path.join(dir, file), JSON.stringify(json));
  return srv;
}
const done = (srv: string) =>
  fs.rmSync(path.dirname(srv), { recursive: true, force: true });

describe("--explain", () => {
  it("lists the filler values, with their label and a sample, and a block to paste", () => {
    const srv = model(NORTHWIND);
    try {
      const text = explain(srv, 20, false);
      assert.match(text, /^4 properties use filler values:/);
      assert.match(text, /Employees\.Extension +"Extension" +\d{4}\n/);
      assert.match(text, /"Employees\.Extension": "####"/);
      assert.match(text, /"Categories\.CategoryName": \["\.\.\.", "\.\.\."\]/);
      assert.match(
        text,
        /To see how every property is generated: --explain all$/,
      );
    } finally {
      done(srv);
    }
  });

  it("proposes a block that, pasted, is valid and leaves no filler values", () => {
    const srv = model(NORTHWIND);
    try {
      const text = explain(srv, 20, false);
      const block = text.slice(
        text.indexOf('"mock"'),
        text.lastIndexOf("}") + 1,
      );
      fs.writeFileSync(path.join(srv, "config.json"), `{ ${block} }`);
      assert.equal(
        explain(srv, 20, false),
        "No property uses filler values. To see how every property is generated: --explain all",
      );
    } finally {
      done(srv);
    }
  });

  it("all: every property, how it's made, where that's decided, and a sample", () => {
    const srv = model(PO_MODEL, {
      "shared.json": {
        mock: { "SalesOrderSet.Status": "Open", Status: ["Open", "Approved"] },
      },
      "Srv/config.json": {
        extends: "../shared.json",
        mock: { "PurchaseOrderSet.Currency": "EUR" },
      },
    });
    try {
      const text = explain(srv, 5, true);
      const line = (p: string) =>
        text.split("\n").find((l) => l.trimStart().startsWith(`${p} `)) ?? "";
      assert.match(text, /^PurchaseOrderSet\n/);
      assert.match(
        line("PurchaseOrderId"),
        /"45########" +built-in +4500000001$/,
      );
      assert.match(line("Currency"), /"EUR" +config\.json +EUR$/);
      assert.match(
        line("Status"),
        new RegExp(
          `one of 2 values +${path.join("..", "shared.json").replace(/\\/g, "\\\\")} +(Open|Approved)$`,
        ),
      );
      assert.match(
        line("TotalAmount"),
        /the sum of its items +PurchaseOrderItemSet/,
      );
      assert.match(
        text,
        /Unused, nothing here has them:\n {2}\.\.[\\/]shared\.json: "SalesOrderSet\.Status"/,
      );
    } finally {
      done(srv);
    }
  });

  it("says when nothing is generated", () => {
    const srv = model(PO_MODEL);
    try {
      assert.equal(
        explain(srv, 0, false),
        "--mock-rows is 0: nothing is generated.",
      );
    } finally {
      done(srv);
    }
  });

  it("is a flag of the odata-prova command, all after it, the model before or after", () => {
    const server = path.join(import.meta.dirname, "..", "server.ts");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [server, ...args], {
        encoding: "utf8",
        timeout: 30000,
      });
    const all = run("--explain", "all", NORTHWIND);
    assert.equal(all.status, 0, all.stderr);
    assert.match(all.stdout, /^Categories\n/);
    const short = run(NORTHWIND, "--explain");
    assert.match(short.stdout, /^4 properties use filler values:/);
    const bad = run(NORTHWIND, "--explain", "everything");
    assert.equal(bad.status, 1);
    assert.match(
      bad.stderr,
      /--explain takes nothing, or all, got 'everything'/,
    );
  });
});
