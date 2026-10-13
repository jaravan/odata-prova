import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// The package's API is lib/app.ts and nothing else (see "Using it in code" in
// docs/architecture.md): package.json's exports leaves every other file internal.
const pkg = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
);

describe("package exports", () => {
  it("only the package itself (lib/app.ts, built) and its package.json", () => {
    assert.deepEqual(pkg.exports, {
      ".": { types: "./dist/lib/app.d.ts", default: "./dist/lib/app.js" },
      "./package.json": "./package.json",
    });
    // main and types, for tools that don't read exports, say the same
    assert.equal(`./${pkg.main}`, pkg.exports["."].default);
    assert.equal(`./${pkg.types}`, pkg.exports["."].types);
  });

  it("an internal file can't be imported", async () => {
    // A package can import itself by name, through its exports like any other user. A
    // variable, since TypeScript would refuse the path at compile time too.
    const internal = "odata-prova/dist/lib/metadata.js";
    await assert.rejects(import(internal), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
  });
});
