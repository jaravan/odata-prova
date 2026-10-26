import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, parseMockKey, parseMockValue } from "../lib/config.ts";

describe("config.json: mock rule values", () => {
  const value = (written: unknown) =>
    parseMockValue(written as never, 'config.json: mock "X"');

  it("reads #s as a running number, zero-padded to their count, the rest kept", () => {
    assert.deepEqual(value("45########"), {
      kind: "count",
      prefix: "45",
      width: 8,
      suffix: "",
    });
    assert.deepEqual(value("####0"), {
      kind: "count",
      prefix: "",
      width: 4,
      suffix: "0",
    });
  });

  it("reads a..b as a range when both ends are numbers or both dates, else as a value", () => {
    assert.deepEqual(value("100..50000"), {
      kind: "range",
      type: "number",
      min: "100",
      max: "50000",
    });
    assert.deepEqual(value("0.5..2.25"), {
      kind: "range",
      type: "number",
      min: "0.5",
      max: "2.25",
    });
    assert.deepEqual(value("2025-01-01..2025-06-30"), {
      kind: "range",
      type: "date",
      min: "2025-01-01",
      max: "2025-06-30",
    });
    assert.deepEqual(value("see..below"), {
      kind: "constant",
      value: "see..below",
    });
    assert.deepEqual(value("1..2025-01-01"), {
      kind: "constant",
      value: "1..2025-01-01",
    });
  });

  it("reads anything else as always that value, and a list as one of its values, never parsed", () => {
    assert.deepEqual(value("EUR"), { kind: "constant", value: "EUR" });
    assert.deepEqual(value(5), { kind: "constant", value: 5 });
    assert.deepEqual(value(false), { kind: "constant", value: false });
    assert.deepEqual(value(null), { kind: "constant", value: null });
    assert.deepEqual(value(["Open", "Open", "A#1", "1..2"]), {
      kind: "list",
      values: ["Open", "Open", "A#1", "1..2"],
    });
  });

  it("says what's wrong, and how to write it", () => {
    assert.throws(() => value([]), /config.json: mock "X": an empty list/);
    assert.throws(
      () => value({ min: 1 }),
      /write a value \("EUR"\), a running number/,
    );
    assert.throws(() => value([["A"]]), /a list holds values, not lists/);
    assert.throws(
      () => value("A#B#"),
      /"A#B#" has 2 runs of #, a running number has one .*write a list: \["A#B#"\]/,
    );
    assert.throws(
      () => value("500..100"),
      /"500..100" starts after it ends, write "100..500"/,
    );
  });
});

describe("config.json: mock rule keys", () => {
  it("are Set.Property or Property, with a complex member after a /", () => {
    assert.deepEqual(parseMockKey("PurchaseOrderSet.Status"), {
      set: "PurchaseOrderSet",
      path: "Status",
    });
    assert.deepEqual(parseMockKey("Status"), { path: "Status" });
    assert.deepEqual(parseMockKey("BusinessPartnerSet.Address/City"), {
      set: "BusinessPartnerSet",
      path: "Address/City",
    });
    assert.deepEqual(parseMockKey("Address/City"), { path: "Address/City" });
  });
});

describe("config.json: extends", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "config-"));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Writes files under a fresh folder; returns its path
  let n = 0;
  const files = (contents: Record<string, unknown>) => {
    const dir = path.join(root, String(++n));
    for (const [file, json] of Object.entries(contents)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(
        path.join(dir, file),
        typeof json === "string" ? json : JSON.stringify(json),
      );
    }
    return dir;
  };
  const rules = (dir: string) =>
    Object.fromEntries(
      loadConfig(path.join(dir, "Srv")).mock.map((r) => [
        r.key,
        [r.value, path.relative(dir, r.file), r.shared],
      ]),
    );

  it("is nothing without a config.json", () => {
    assert.deepEqual(loadConfig(files({ "Srv/metadata.xml": "" })), {
      operations: {},
      mock: [],
      files: [],
    });
  });

  it("merges shared rules per key, the model's own winning, case aside", () => {
    const dir = files({
      "shared/config.json": {
        mock: { Status: ["Open"], Currency: "EUR" },
        operations: { Approve: { set: { Status: "Approved" } } },
      },
      "Srv/config.json": {
        extends: "../shared/config.json",
        mock: { status: "Closed" },
      },
    });
    assert.deepEqual(rules(dir), {
      Currency: [
        { kind: "constant", value: "EUR" },
        path.join("shared", "config.json"),
        true,
      ],
      status: [
        { kind: "constant", value: "Closed" },
        path.join("Srv", "config.json"),
        false,
      ],
    });
    // operations come along
    const { operations } = loadConfig(path.join(dir, "Srv"));
    assert.deepEqual(operations.Approve.set, { Status: "Approved" });
    assert.equal(
      operations.Approve.file,
      path.join(dir, "shared", "config.json"),
    );
  });

  it("takes a list, a later file over an earlier one, and chains", () => {
    const dir = files({
      "a.json": { extends: "./c.json", mock: { X: "a", Y: "a" } },
      "b.json": { mock: { X: "b" } },
      "c.json": { mock: { Z: "c", Y: "c" } },
      "Srv/config.json": { extends: ["../a.json", "../b.json"] },
    });
    const values = Object.fromEntries(
      Object.entries(rules(dir)).map(([k, [v]]) => [
        k,
        (v as { value: string }).value,
      ]),
    );
    assert.deepEqual(values, { Z: "c", Y: "a", X: "b" });
    // Every file read, the model's own first (see live-rules.ts)
    assert.deepEqual(
      loadConfig(path.join(dir, "Srv")).files.map((f) => path.relative(dir, f)),
      [path.join("Srv", "config.json"), "a.json", "c.json", "b.json"],
    );
  });

  it("refuses a cycle, a file that isn't there, and one that isn't JSON", () => {
    const cycle = files({
      "a.json": { extends: "./Srv/config.json" },
      "Srv/config.json": { extends: "../a.json" },
    });
    assert.throws(
      () => loadConfig(path.join(cycle, "Srv")),
      /which extends it back: .*config.json -> .*a.json -> .*config.json/,
    );

    const missing = files({ "Srv/config.json": { extends: "../nope.json" } });
    assert.throws(
      () => loadConfig(path.join(missing, "Srv")),
      /nope.json: no such file, extended by .*config.json/,
    );

    const broken = files({ "Srv/config.json": "{ mock: " });
    assert.throws(() => loadConfig(path.join(broken, "Srv")), /config.json: /);

    const notRules = files({ "Srv/config.json": { mock: ["X"] } });
    assert.throws(
      () => loadConfig(path.join(notRules, "Srv")),
      /mock is an object of rules/,
    );
  });
});
