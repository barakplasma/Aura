import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCaptureSize } from "../lib/frame.js";

test("normalizeCaptureSize keeps the legacy frame size by default", () => {
  assert.deepEqual(normalizeCaptureSize(), { width: 640, height: 480 });
  assert.deepEqual(normalizeCaptureSize("unexpected"), {
    width: 640,
    height: 480,
  });
});

test("normalizeCaptureSize returns each supported live capture preset", () => {
  assert.deepEqual(normalizeCaptureSize("512x384"), {
    width: 512,
    height: 384,
  });
  assert.deepEqual(normalizeCaptureSize("320x240"), {
    width: 320,
    height: 240,
  });
});
