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

test("normalizeCaptureSize accepts higher and bounded custom dimensions", () => {
  assert.deepEqual(normalizeCaptureSize("1920x1080"), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(normalizeCaptureSize("1024x640"), {
    width: 1024,
    height: 640,
  });
  assert.deepEqual(normalizeCaptureSize("4097x480"), {
    width: 640,
    height: 480,
  });
  assert.deepEqual(normalizeCaptureSize("3841x2160"), {
    width: 640,
    height: 480,
  });
});
