import test from "node:test";
import assert from "node:assert/strict";
import {
  toGray,
  motionScore,
  isMotion,
  motionPreset,
  MOTION_PRESETS,
  GATE_WIDTH,
  GATE_HEIGHT,
} from "../lib/motion.js";

const N = GATE_WIDTH * GATE_HEIGHT;

// A flat grey frame as RGBA bytes.
function flat(level, n = N) {
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = level;
    rgba[i * 4 + 1] = level;
    rgba[i * 4 + 2] = level;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

// Paint a rectangle covering `fraction` of the grid at `level`.
function withBlock(gray, fraction, level) {
  const out = Uint8ClampedArray.from(gray);
  const count = Math.round(gray.length * fraction);
  for (let i = 0; i < count; i++) out[i] = level;
  return out;
}

test("toGray weights channels and can reuse a buffer", () => {
  const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  const gray = toGray(rgba);
  assert.equal(gray.length, 2);
  assert.equal(gray[0], Math.round((255 * 299) / 1000));
  assert.equal(gray[1], Math.round((255 * 587) / 1000));
  const reused = new Uint8ClampedArray(2);
  assert.equal(toGray(rgba, reused), reused, "writes into the buffer given");
});

test("an identical frame scores zero motion", () => {
  const gray = toGray(flat(120));
  const ref = toGray(flat(120));
  assert.equal(motionScore(gray, ref, { noiseFloor: 24 }), 0);
  assert.equal(isMotion(0, MOTION_PRESETS.high), false);
});

test("sensor noise does not register as motion", () => {
  const base = toGray(flat(120));
  const noisy = Uint8ClampedArray.from(base, (v, i) => v + ((i * 7) % 11) - 5);
  const score = motionScore(noisy, base, { noiseFloor: 16 });
  assert.equal(score, 0, "±5 levels is under every preset's noise floor");
});

test("a global brightness shift does not register as motion", () => {
  // Someone flicks the light on: every pixel jumps 60 levels at once. Without
  // the mean-delta subtraction this would read as 100 % motion and wake the
  // VLM on every light switch in the building.
  const base = toGray(flat(100));
  const brighter = toGray(flat(160));
  assert.equal(motionScore(brighter, base, { noiseFloor: 24 }), 0);
});

test("a local change over the minimum area does register", () => {
  const base = toGray(flat(120));
  const moved = withBlock(base, 0.12, 230);
  const score = motionScore(moved, base, { noiseFloor: 24 });
  // The mean shift from a 12 % block is ~13 levels, well under the ~110-level
  // local delta, so the block still stands out.
  assert.ok(score > 0.11 && score < 0.13, `score was ${score}`);
  assert.equal(isMotion(score, MOTION_PRESETS.medium), true);
  assert.equal(isMotion(score, MOTION_PRESETS.low), true);
});

test("a change smaller than the preset's area is ignored at that preset", () => {
  const base = toGray(flat(120));
  const score = motionScore(withBlock(base, 0.03, 230), base, { noiseFloor: 24 });
  assert.equal(isMotion(score, MOTION_PRESETS.low), false, "LOW wants 10 %");
  assert.equal(isMotion(score, MOTION_PRESETS.medium), false, "MEDIUM wants 5 %");
  assert.equal(isMotion(score, MOTION_PRESETS.high), true, "HIGH wants 2 %");
});

test("a missing or mismatched reference is treated as changed", () => {
  const gray = toGray(flat(120));
  assert.equal(motionScore(gray, null, {}), 1);
  assert.equal(motionScore(gray, new Uint8ClampedArray(4), {}), 1);
  assert.equal(motionScore(new Uint8ClampedArray(0), new Uint8ClampedArray(0), {}), 1);
  assert.equal(isMotion(1, MOTION_PRESETS.low), true);
});

test("motionPreset falls back to medium for unknown names", () => {
  assert.deepEqual(motionPreset("nope"), MOTION_PRESETS.medium);
  assert.deepEqual(motionPreset(undefined), MOTION_PRESETS.medium);
  assert.deepEqual(motionPreset("high"), MOTION_PRESETS.high);
});
