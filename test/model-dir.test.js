const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { findModelDir } = require("../lib/app");

const MODELS = path.join(__dirname, "..", "..", "models");
const FIXTURES = path.join(__dirname, "fixtures");

// MODEL_DIR can name the model itself, or a folder holding exactly one model (how the
// Kubernetes model image is mounted, so the image alone decides which model is served).
describe("MODEL_DIR lookup", () => {
  it("takes a model folder as is", () => {
    const dir = path.join(MODELS, "PurchaseOrderSrv");
    assert.equal(findModelDir(dir), dir);
  });

  it("picks the only model inside a folder", () => {
    assert.equal(findModelDir(MODELS), path.join(MODELS, "PurchaseOrderSrv"));
  });

  it("refuses to guess between several models, and names them", () => {
    assert.throws(() => findModelDir(FIXTURES), /holds \d+ models \(.*SalesSrv.*\): point MODEL_DIR at one of them/);
  });

  it("leaves a missing folder for the loader to report", () => {
    const missing = path.join(MODELS, "Nope");
    assert.equal(findModelDir(missing), missing);
  });
});
