import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldCatchUp,
  resumeWindowOpen,
  nextReconnectDelayMs,
} from "../lib/keepalive.js";

test("shouldCatchUp is false while within double the scheduled gap", () => {
  assert.equal(shouldCatchUp(1000, 5000, 1000), false); // no elapsed time
  assert.equal(shouldCatchUp(1000, 5000, 10999), false); // just under 2×gap
});

test("shouldCatchUp fires once elapsed exceeds double the scheduled gap", () => {
  assert.equal(shouldCatchUp(1000, 5000, 11001), true); // just over 2×gap
  assert.equal(shouldCatchUp(1000, 5000, 60000), true); // way over
});

test("shouldCatchUp is exactly false at the 2×gap boundary (strictly greater)", () => {
  assert.equal(shouldCatchUp(1000, 5000, 11000), false);
});

test("shouldCatchUp always fires when there is no prior scan", () => {
  assert.equal(shouldCatchUp(null, 5000, 5001), true);
  assert.equal(shouldCatchUp(undefined, 5000, 0), true);
  assert.equal(shouldCatchUp(NaN, 5000, 0), true);
});

test("resumeWindowOpen is true while armedAt is within maxAgeMs of now", () => {
  const maxAge = 12 * 3600 * 1000;
  assert.equal(resumeWindowOpen(1000, 1000, maxAge), true); // just armed
  assert.equal(resumeWindowOpen(1, maxAge + 1, maxAge), true); // exactly at the boundary
});

test("resumeWindowOpen is false once maxAgeMs has elapsed", () => {
  const maxAge = 12 * 3600 * 1000;
  assert.equal(resumeWindowOpen(1, maxAge + 2, maxAge), false);
});

test("resumeWindowOpen is false when never armed", () => {
  assert.equal(resumeWindowOpen(0, Date.now(), 12 * 3600 * 1000), false);
  assert.equal(resumeWindowOpen(null, Date.now(), 12 * 3600 * 1000), false);
  assert.equal(resumeWindowOpen(undefined, Date.now(), 12 * 3600 * 1000), false);
});

test("resumeWindowOpen rejects a future armedAt (clock skew)", () => {
  assert.equal(resumeWindowOpen(2000, 1000, 12 * 3600 * 1000), false);
});

test("nextReconnectDelayMs follows the 1s/3s/8s backoff then gives up", () => {
  assert.equal(nextReconnectDelayMs(1), 1000);
  assert.equal(nextReconnectDelayMs(2), 3000);
  assert.equal(nextReconnectDelayMs(3), 8000);
  assert.equal(nextReconnectDelayMs(4), null);
  assert.equal(nextReconnectDelayMs(5), null);
});
