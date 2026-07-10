// Aura latency stats — pure helpers for rolling percentile tracking.
//
// These feed two things in the scan loop: the progress estimate (how long the
// current frame should take, from the median) and the self-tuning request
// timeout (p90 × 1.5, so a hung inference fails fast without killing normal
// variance). Kept dependency-free and Node-friendly so it's unit-testable and
// safe to import from both the browser hook and test/.

const DEFAULT_WINDOW = 40;

// Append a latency sample (ms), keeping at most `window` most-recent samples.
// Non-positive / non-finite values are ignored (a timeout or error is not a
// real processing time). Returns a NEW array — never mutates the input.
export function recordLatency(samples, ms, window = DEFAULT_WINDOW) {
  if (!Number.isFinite(ms) || ms <= 0) return samples;
  const next = samples.concat(ms);
  return next.length > window ? next.slice(next.length - window) : next;
}

// Nearest-rank percentile (p in 0..100). Returns null when there are no
// samples. Does not mutate `samples`.
export function percentile(samples, p) {
  if (!samples || samples.length === 0) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx];
}

// The self-tuning per-request timeout: p90 × 1.5, clamped to [floorMs, ceilMs].
// Falls back to `ceilMs` (the operator's configured timeout) until we have
// enough samples to trust the percentile.
export function tunedTimeoutMs(samples, { floorMs, ceilMs, minSamples = 5 }) {
  if (!samples || samples.length < minSamples) return ceilMs;
  const p90 = percentile(samples, 90);
  if (p90 == null) return ceilMs;
  return Math.min(ceilMs, Math.max(floorMs, Math.round(p90 * 1.5)));
}
