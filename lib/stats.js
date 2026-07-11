// Aura latency stats — pure helpers for rolling percentile tracking.
//
// These feed two things in the scan loop: the progress estimate (how long the
// current frame should take, from the median) and the self-tuning request
// timeout (mean + 1 stddev of observed successful latencies, so a hung
// inference fails fast without killing normal variance and without any
// operator-set ceiling). Kept dependency-free and Node-friendly so it's
// unit-testable and safe to import from both the browser hook and test/.

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

// The self-tuning per-request timeout: mean + 1 stddev of observed successful
// latencies, floored at `floorMs`. There is no operator-set ceiling — the
// timeout is derived entirely from what this session has actually seen.
// Before the first sample lands there's no basis for a statistical bound, so
// this returns `bootstrapMs` (a generous fixed default) for that one request;
// every request after that is judged against the growing distribution.
export function tunedTimeoutMs(samples, { floorMs, minSamples = 1, bootstrapMs = 30000 }) {
  if (!samples || samples.length < minSamples) return bootstrapMs;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  const stddev = Math.sqrt(variance);
  return Math.max(floorMs, Math.round(mean + stddev));
}
