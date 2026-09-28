const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { findModelDir } = require("../lib/app");

const MODELS = path.join(__dirname, "..", "..", "models");

// MODEL_DIR can name the model itself, or a folder holding exactly one model (how the
// Kubernetes model image is mounted, so the image alone decides which model is served).
describe("MODEL_DIR lookup", () => {
  let single; // a folder holding one model, like the Kubernetes volume
  before(() => {
    single = fs.mkdtempSync(path.join(os.tmpdir(), "models-"));
    fs.mkdirSync(path.join(single, "OnlySrv"));
    fs.copyFileSync(path.join(MODELS, "PurchaseOrderSrv", "metadata.xml"), path.join(single, "OnlySrv", "metadata.xml"));
  });
  after(() => fs.rmSync(single, { recursive: true, force: true }));

  it("takes a model folder as is", () => {
    const dir = path.join(MODELS, "PurchaseOrderSrv");
    assert.equal(findModelDir(dir), dir);
  });

  it("picks the only model inside a folder", () => {
    assert.equal(findModelDir(single), path.join(single, "OnlySrv"));
  });

  it("refuses to guess between several models, and names them", () => {
    assert.throws(() => findModelDir(MODELS), /holds 3 models \(Northwind, PurchaseOrderSrv, TripPin\): point MODEL_DIR at one of them/);
  });

  it("leaves a missing folder for the loader to report", () => {
    const missing = path.join(MODELS, "Nope");
    assert.equal(findModelDir(missing), missing);
  });
});
