// Stage 0 of the scan cascade: a pixel diff cheap enough to run on every
// gate tick without touching the GPU at all (see docs/PRD-object-gate.md and
// the motion gate in docs/PRD-local-prefilters.md).
//
// Its only job is to keep the detector off the GPU on a still scene: a hallway
// at 3 a.m. should cost a fraction of a millisecond per tick, not 30 ms of
// WebGPU. It is deliberately dumber than the detector behind it — a false
// positive here costs one YOLO pass, which is why the thresholds lean toward
// recall.
//
// Pure and Node-testable: callers pass raw RGBA bytes from a small canvas.

// Grid the frame is sampled at. Small on purpose: at 64x48 the whole diff is
// ~3k comparisons, and anything a monitor cares about is far bigger than one
// cell of it.
export const GATE_WIDTH = 64;
export const GATE_HEIGHT = 48;

export const MOTION_PRESETS = {
  low: { minArea: 0.1, noiseFloor: 32 },
  medium: { minArea: 0.05, noiseFloor: 24 },
  high: { minArea: 0.02, noiseFloor: 16 },
};

export function motionPreset(sensitivity) {
  return MOTION_PRESETS[sensitivity] || MOTION_PRESETS.medium;
}

/**
 * RGBA bytes → one luma byte per pixel (Rec. 601, the same weighting every
 * video codec uses). Writes into `out` when given one, so the gate loop can
 * reuse two buffers for the lifetime of a session instead of allocating on
 * every tick.
 */
export function toGray(rgba, out = null) {
  const n = rgba.length >> 2;
  const gray = out && out.length === n ? out : new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    gray[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return gray;
}

/**
 * Fraction of pixels that changed, after cancelling out a global brightness
 * shift.
 *
 * The mean subtraction is what makes this usable indoors: auto-exposure and
 * white balance move every pixel at once, and without it flicking a light on
 * reads as 100 % motion. Subtracting the mean delta leaves only *local*
 * change, which is what a person walking in actually is.
 */
export function motionScore(gray, refGray, opts = {}) {
  const { noiseFloor = 24 } = opts;
  if (!gray || !refGray || gray.length !== refGray.length || gray.length === 0)
    return 1; // no usable reference — treat as "changed" and let stage 1 decide
  let sum = 0;
  let refSum = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
    refSum += refGray[i];
  }
  const shift = (sum - refSum) / gray.length;
  let changed = 0;
  for (let i = 0; i < gray.length; i++) {
    if (Math.abs(gray[i] - refGray[i] - shift) > noiseFloor) changed++;
  }
  return changed / gray.length;
}

/** Did enough of the frame change to be worth a detector pass? */
export function isMotion(score, opts = {}) {
  const { minArea = 0.05 } = opts;
  return score >= minArea;
}
