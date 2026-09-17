import test from "node:test";
import assert from "node:assert/strict";
import { processingProgress } from "../lib/progress.js";

test("processingProgress marks a scan that exceeds its estimate as an overrun", () => {
  assert.deepEqual(processingProgress(8200, 5000), {
    pct: 95,
    etaMs: null,
    elapsedMs: 8200,
    estimateMs: 5000,
    overrun: true,
  });
});
