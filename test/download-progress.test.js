import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProgressState,
  recordProgress,
  aggregateProgress,
} from "../lib/download-progress.js";

test("aggregateProgress sums bytes across files instead of reporting one file's own numbers", () => {
  const state = createProgressState();
  recordProgress(state, { file: "config.json", loaded: 500, total: 500 });
  recordProgress(state, { file: "model_q4.onnx", loaded: 1000, total: 4000 });
  const { loaded, total, pct } = aggregateProgress(state, null);
  assert.equal(loaded, 1500);
  assert.equal(total, 4500);
  assert.equal(pct, Math.round((1500 / 4500) * 100));
});

test("without an expected total, pct can only be computed from totals seen so far (may still dip when a new file appears)", () => {
  const state = createProgressState();
  recordProgress(state, { file: "a.json", loaded: 100, total: 100 });
  const first = aggregateProgress(state, null);
  assert.equal(first.pct, 100); // only file known so far is fully loaded

  // A second, much bigger file starts — without a pre-known grand total the
  // denominator jumps, which is exactly the case a fixed expectedTotal fixes.
  recordProgress(state, { file: "weights.onnx", loaded: 0, total: 9900 });
  const second = aggregateProgress(state, null);
  assert.equal(second.total, 10000);
  assert.equal(second.pct, 1); // dipped from 100% to 1% — the bug being fixed
});

test("with a fixed expectedTotal, pct is monotonic across the same file handoff", () => {
  const state = createProgressState();
  const expectedTotal = 10000;
  recordProgress(state, { file: "a.json", loaded: 100, total: 100 });
  const first = aggregateProgress(state, expectedTotal);
  assert.equal(first.pct, 1); // 100/10000, small but never drops later

  recordProgress(state, { file: "weights.onnx", loaded: 0, total: 9900 });
  const second = aggregateProgress(state, expectedTotal);
  assert.ok(second.pct >= first.pct, "pct must not decrease once expectedTotal is known");

  recordProgress(state, { file: "weights.onnx", loaded: 9900, total: 9900 });
  const third = aggregateProgress(state, expectedTotal);
  assert.equal(third.pct, 100);
  assert.ok(third.pct >= second.pct);
});

test("aggregateProgress caps pct at 100 even if reported bytes exceed the estimated total", () => {
  const state = createProgressState();
  recordProgress(state, { file: "a.onnx", loaded: 12000, total: 12000 });
  const { pct } = aggregateProgress(state, 10000); // estimate undercounted
  assert.equal(pct, 100);
});

test("aggregateProgress reports a null pct when no size information exists yet", () => {
  const state = createProgressState();
  const { pct, total } = aggregateProgress(state, null);
  assert.equal(total, 0);
  assert.equal(pct, null);
});

test("recordProgress overwrites a file's loaded bytes on repeated events for the same file", () => {
  const state = createProgressState();
  recordProgress(state, { file: "a.onnx", loaded: 10, total: 100 });
  recordProgress(state, { file: "a.onnx", loaded: 50, total: 100 });
  const { loaded, total } = aggregateProgress(state, null);
  assert.equal(loaded, 50); // not 10 + 50
  assert.equal(total, 100); // not double-counted either
});
