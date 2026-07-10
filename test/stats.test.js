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

test('tunedTimeoutMs falls back to the ceiling until enough samples', () => {
  const opts = { floorMs: 4000, ceilMs: 30000, minSamples: 5 };
  assert.equal(tunedTimeoutMs([100, 200], opts), 30000);
  assert.equal(tunedTimeoutMs([], opts), 30000);
});

test('tunedTimeoutMs tightens to p90 x 1.5 and respects the bounds', () => {
  // p90 of these ten is 900ms → ×1.5 = 1350, but floor lifts it to 4000.
  const fast = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
  assert.equal(tunedTimeoutMs(fast, { floorMs: 4000, ceilMs: 30000 }), 4000);
  // Slow model: p90 = 20000 → ×1.5 = 30000, clamped to the 30s ceiling.
  const slow = [18000, 18000, 18000, 18000, 18000, 19000, 19000, 20000, 20000, 20000];
  assert.equal(tunedTimeoutMs(slow, { floorMs: 4000, ceilMs: 30000 }), 30000);
  // Mid: p90 = 4800 (nearest-rank) → ×1.5 = 7200, within bounds.
  const mid = [2000, 2500, 3000, 3200, 3500, 4000, 4200, 4500, 4800, 5000];
  assert.equal(tunedTimeoutMs(mid, { floorMs: 4000, ceilMs: 30000 }), 7200);
});
