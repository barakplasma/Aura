import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emaUpdate, computeGapMs } from '../lib/scheduler.js';

test('emaUpdate seeds on the first finite value then blends', () => {
  assert.equal(emaUpdate(null, 100), 100); // seed
  assert.equal(emaUpdate(undefined, 100), 100);
  // 100 + 0.3 × (200 − 100) = 130
  assert.equal(emaUpdate(100, 200), 130);
  // Custom alpha.
  assert.equal(emaUpdate(100, 200, 0.5), 150);
  // Non-finite samples are ignored (a timeout is not a measurement).
  assert.equal(emaUpdate(100, NaN), 100);
  assert.equal(emaUpdate(100, Infinity), 100);
});

test('interval mode passes scanEvery through as a millisecond gap', () => {
  assert.equal(computeGapMs('interval', { scanEvery: 5 }, {}), 5000);
  assert.equal(computeGapMs('interval', { scanEvery: 12 }, {}), 12000);
  // Unparseable / non-positive falls back to the 5s default.
  assert.equal(computeGapMs('interval', { scanEvery: 'x' }, {}), 5000);
  assert.equal(computeGapMs('interval', { scanEvery: 0 }, {}), 5000);
  // Unknown modes degrade to interval so a bad setting can't stall the loop.
  assert.equal(computeGapMs('bogus', { scanEvery: 3 }, {}), 3000);
});

test('interval mode accepts the full 1s..12h+ range, including fractional seconds', () => {
  assert.equal(computeGapMs('interval', { scanEvery: 1 }, {}), 1000);
  assert.equal(computeGapMs('interval', { scanEvery: 0.5 }, {}), 500);
  assert.equal(computeGapMs('interval', { scanEvery: 5 * 60 }, {}), 300000);
  assert.equal(computeGapMs('interval', { scanEvery: 12 * 3600 }, {}), 43200000);
});

test('an extreme scanEvery is clamped to the setTimeout 32-bit int max, not overflowed', () => {
  // 1,000,000 hours in ms would overflow 2^31-1 and fire almost immediately
  // if passed straight to setTimeout — must be clamped instead.
  const gap = computeGapMs('interval', { scanEvery: 1e6 * 3600 }, {});
  assert.equal(gap, 2147483647);
  assert.ok(gap <= 2147483647);
});

test('max mode returns the 250ms floor regardless of knobs/sample', () => {
  assert.equal(computeGapMs('max', { scanEvery: 30 }, { tokens: 5000, durationMs: 800 }), 250);
});

test('budget mode bootstraps to the interval gap until a sample lands', () => {
  // No tokens and no bytes yet → interval fallback.
  assert.equal(computeGapMs('budget', { scanEvery: 7, budgetPerHour: 0.1, rate: 0.1 }, {}), 7000);
});

test('budget cost cap derives the gap from spend', () => {
  // 1000 tokens × $0.10/1M = $0.0001/scan; 3.6e6 × 0.0001 / 0.10 = 3600ms.
  const gap = computeGapMs('budget',
    { scanEvery: 5, budgetPerHour: 0.1, rate: 0.1 },
    { tokens: 1000, durationMs: 0 });
  assert.equal(gap, 3600);
  // Scan duration is subtracted from the target period.
  const gap2 = computeGapMs('budget',
    { scanEvery: 5, budgetPerHour: 0.1, rate: 0.1 },
    { tokens: 1000, durationMs: 600 });
  assert.equal(gap2, 3000);
  // A very fast/cheap scan can't push the gap below zero.
  const gap3 = computeGapMs('budget',
    { scanEvery: 5, budgetPerHour: 100, rate: 0.1 },
    { tokens: 1000, durationMs: 600 });
  assert.equal(gap3, 0);
});

test('budget network cap derives the gap from payload bytes', () => {
  // 100000 bytes, 1 MB/hour: 3.6e6 × 1e5 / 1e6 = 360000ms.
  const gap = computeGapMs('budget',
    { scanEvery: 5, networkMbPerHour: 1 },
    { bytes: 100000, durationMs: 0 });
  assert.equal(gap, 360000);
});

test('budget mode: most restrictive cap wins', () => {
  // Cost cap → 3600ms, network cap → 360000ms; the tighter (larger gap) wins.
  const gap = computeGapMs('budget',
    { scanEvery: 5, budgetPerHour: 0.1, rate: 0.1, networkMbPerHour: 1 },
    { tokens: 1000, bytes: 100000, durationMs: 0 });
  assert.equal(gap, 360000);
});

test('budget cost cap disabled gracefully when tokens EMA is null', () => {
  // No usage data + no network cap → can only fall back to interval.
  assert.equal(computeGapMs('budget',
    { scanEvery: 8, budgetPerHour: 0.1, rate: 0.1 },
    { tokens: null, bytes: 50000, durationMs: 0 }), 8000);
  // …but the network cap still works when a byte sample exists.
  assert.equal(computeGapMs('budget',
    { scanEvery: 8, budgetPerHour: 0.1, rate: 0.1, networkMbPerHour: 1 },
    { tokens: null, bytes: 100000, durationMs: 0 }), 360000);
  // A zero rate (free local model) also disables the cost cap.
  assert.equal(computeGapMs('budget',
    { scanEvery: 8, budgetPerHour: 0.1, rate: 0 },
    { tokens: 1000, bytes: null, durationMs: 0 }), 8000);
});
