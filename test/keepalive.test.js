import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shouldCatchUp,
  resumeWindowOpen,
  nextReconnectDelayMs,
  RECONNECT_ATTEMPTS,
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

test("nextReconnectDelayMs follows the visible ladder then gives up", () => {
  assert.equal(nextReconnectDelayMs(1), 1000);
  assert.equal(nextReconnectDelayMs(2), 3000);
  assert.equal(nextReconnectDelayMs(3), 8000);
  assert.equal(nextReconnectDelayMs(4), 15000);
  assert.equal(nextReconnectDelayMs(5), 30000);
  assert.equal(nextReconnectDelayMs(6), 60000);
  // Visible operator, ladder exhausted: stop() and tell them to re-arm.
  assert.equal(nextReconnectDelayMs(7), null);
  assert.equal(nextReconnectDelayMs(50), null);
});

test("nextReconnectDelayMs never gives up while hidden", () => {
  // Android refuses background getUserMedia outright, so while hidden every
  // failure is the OS declining, not a dead camera — hold the slow cadence
  // and let the visibility handler restart the ladder on return.
  assert.equal(nextReconnectDelayMs(1, true), 30000);
  assert.equal(nextReconnectDelayMs(7, true), 30000);
  assert.equal(nextReconnectDelayMs(50, true), 30000);
});

test("RECONNECT_ATTEMPTS matches the visible ladder length", () => {
  // The hook prints "(n/N)" from this constant; it must agree with where
  // nextReconnectDelayMs starts returning null.
  assert.equal(RECONNECT_ATTEMPTS, 6);
  assert.equal(nextReconnectDelayMs(RECONNECT_ATTEMPTS), 60000);
  assert.equal(nextReconnectDelayMs(RECONNECT_ATTEMPTS + 1), null);
});
