import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordLatency, percentile, tunedTimeoutMs } from '../lib/stats.js';

test('recordLatency appends without mutating and bounds the window', () => {
  const a = [];
  const b = recordLatency(a, 100);
  assert.deepEqual(a, []); // input untouched
  assert.deepEqual(b, [100]);
  // Window keeps only the most-recent N.
  let s = [];
  for (let i = 1; i <= 45; i++) s = recordLatency(s, i, 40);
  assert.equal(s.length, 40);
  assert.equal(s[0], 6); // 1..5 dropped
  assert.equal(s[s.length - 1], 45);
});

test('recordLatency ignores timeouts and junk values', () => {
  assert.deepEqual(recordLatency([50], 0), [50]);
  assert.deepEqual(recordLatency([50], -1), [50]);
  assert.deepEqual(recordLatency([50], NaN), [50]);
  assert.deepEqual(recordLatency([50], Infinity), [50]);
});

test('percentile uses nearest-rank and handles the empty case', () => {
  assert.equal(percentile([], 90), null);
  const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(s, 50), 50);
  assert.equal(percentile(s, 90), 90);
  assert.equal(percentile(s, 100), 100);
  // Order-independent.
  assert.equal(percentile([30, 10, 20], 50), 20);
});

test('tunedTimeoutMs falls back to the bootstrap default until a sample lands', () => {
  const opts = { floorMs: 4000, minSamples: 1 };
  assert.equal(tunedTimeoutMs([], opts), 30000);
  assert.equal(tunedTimeoutMs(null, opts), 30000);
  // Custom bootstrap default.
  assert.equal(tunedTimeoutMs([], { floorMs: 4000, minSamples: 1, bootstrapMs: 9000 }), 9000);
});

test('tunedTimeoutMs is mean + 1 stddev, floored', () => {
  // A single sample has zero stddev, so the timeout is just that latency —
  // floored when it's below the safety minimum.
  assert.equal(tunedTimeoutMs([500], { floorMs: 4000 }), 4000);
  assert.equal(tunedTimeoutMs([5000], { floorMs: 4000 }), 5000);
  // Consistent latencies (~500ms, low variance) stay near the mean, floored.
  const fast = [480, 500, 510, 495, 505, 500, 490, 500, 510, 500];
  assert.equal(tunedTimeoutMs(fast, { floorMs: 4000 }), 4000);
  // Wider spread pushes the bound above the floor via the stddev term.
  const varied = [1000, 2000, 1500, 3000, 1200, 2500, 1800, 2200, 1300, 2800];
  const mean = varied.reduce((a, b) => a + b, 0) / varied.length;
  const variance = varied.reduce((a, b) => a + (b - mean) ** 2, 0) / varied.length;
  const expected = Math.max(4000, Math.round(mean + Math.sqrt(variance)));
  assert.equal(tunedTimeoutMs(varied, { floorMs: 4000 }), expected);
});
