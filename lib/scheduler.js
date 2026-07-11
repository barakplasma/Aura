// Aura scan scheduler — pure helpers that turn a scan-timing mode plus the
// operator's caps into the gap (ms) inserted after each serial scan completes.
//
// Scheduling stays strictly serial (one scan in flight, frame captured at send
// time), so modes only change the *gap*. Kept dependency-free and Node-friendly
// so it's unit-testable and safe to import from both the browser hook and test/.

// Freshest-image mode still yields a beat to the browser/UI between scans.
const MAX_FLOOR_MS = 250;
const DEFAULT_SCAN_EVERY_S = 5;

// Exponential moving average. Seeds on the first finite value; ignores
// non-finite samples (a timeout or missing usage isn't a real measurement).
export function emaUpdate(prev, value, alpha = 0.3) {
  if (!Number.isFinite(value)) return prev;
  if (prev == null || !Number.isFinite(prev)) return value;
  return prev + alpha * (value - prev);
}

// The `interval` gap: fixed SCAN EVERY seconds (fractional allowed — the
// operator enters a number + unit, e.g. 1s, 5m, 12h), defaulting when
// unparseable.
function intervalGapMs(scanEvery) {
  const secs = parseFloat(scanEvery);
  return (Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_SCAN_EVERY_S) * 1000;
}

// Compute the post-scan gap (ms) for the given mode.
//   knobs  — { scanEvery, budgetPerHour, networkMbPerHour, rate }
//   sample — per-session EMAs { tokens, bytes, durationMs } (any may be null)
//
// interval → fixed scanEvery. max → 250 ms floor. budget → derived from the
// spend/data caps, most-restrictive-wins (below). Unknown modes fall back to
// interval so a bad setting can never stall the loop.
export function computeGapMs(mode, knobs = {}, sample = {}) {
  if (mode === 'max') return MAX_FLOOR_MS;
  if (mode !== 'budget') return intervalGapMs(knobs.scanEvery);

  const { tokens, bytes, durationMs } = sample;
  const dur = Number.isFinite(durationMs) ? durationMs : 0;
  const haveTokens = Number.isFinite(tokens);
  const haveBytes = Number.isFinite(bytes);

  // Bootstrap: no measurement of either dimension yet → behave like interval.
  if (!haveTokens && !haveBytes) return intervalGapMs(knobs.scanEvery);

  const gaps = [];

  // Cost cap: needs a token sample, a positive $/1M rate, and a positive
  // budget. A provider that never returns usage (tokens EMA null) or a free
  // local model (rate 0) simply disables this cap.
  const rate = Number(knobs.rate);
  const budgetPerHour = Number(knobs.budgetPerHour);
  if (haveTokens && rate > 0 && budgetPerHour > 0) {
    const costPerScan = tokens * rate / 1e6;
    gaps.push(Math.max(0, 3600e3 * costPerScan / budgetPerHour - dur));
  }

  // Network cap: needs a payload-byte sample and a positive MB/hour cap
  // (blank/0 = off). Measured client-side, so it works even with no usage.
  const mbPerHour = Number(knobs.networkMbPerHour);
  if (haveBytes && mbPerHour > 0) {
    gaps.push(Math.max(0, 3600e3 * bytes / (mbPerHour * 1e6) - dur));
  }

  // No active cap (e.g. no usage data and no MB cap) → can't derive a cadence,
  // so fall back to interval behavior.
  if (gaps.length === 0) return intervalGapMs(knobs.scanEvery);

  return Math.max(...gaps);
}
