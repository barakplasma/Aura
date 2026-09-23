import test from "node:test";
import assert from "node:assert/strict";
import { makeLogitCapture } from "../lib/logit-capture.js";
import { verdictStats } from "../lib/logprob.js";

// These tests exist because the previous mechanism failed silently. The worker
// asked `generate({ output_scores: true })` for scores, transformers.js
// accepted the option and ignored it, `Array.isArray(gen)` was false, and every
// scan posted `logits: null` — so alert confidence came from the parser's
// default 100 and no test noticed. Capture now happens in the
// logits-processor chain, which is plain JS and therefore testable here.

test("captures the first step's row and passes logits through untouched", () => {
  const { state, process: onLogits } = makeLogitCapture();
  const row = Float32Array.from([2, 0, 1, 5]);
  const out = onLogits([[1n]], { data: row, dims: [1, 4] });
  assert.equal(out.data, row, "must hand back the logits it was given");
  assert.deepEqual(Array.from(state.row), [2, 0, 1, 5]);
  assert.equal(state.steps, 1);

  // Step 1 is where the verdict is committed; later steps must not overwrite it.
  onLogits([[1n, 2n]], { data: Float32Array.from([9, 9, 9, 9]), dims: [1, 4] });
  assert.deepEqual(Array.from(state.row), [2, 0, 1, 5]);
  assert.equal(state.steps, 2, "later steps still count, so a rambling answer shows");
});

test("copies instead of aliasing, so the next step cannot rewrite it", () => {
  const { state, process: onLogits } = makeLogitCapture();
  const buffer = new Float32Array([1, 2, 3]);
  onLogits([], { data: buffer, dims: [1, 3] });
  buffer[0] = 99; // the generation loop reuses this buffer for the next step
  assert.equal(state.row[0], 1);
  assert.notEqual(state.row, buffer);
});

test("bounds the copy to one vocabulary row when batched", () => {
  const { state, process: onLogits } = makeLogitCapture();
  onLogits([], { data: Float32Array.from([1, 2, 3, 4, 5, 6]), dims: [2, 3] });
  assert.deepEqual(Array.from(state.row), [1, 2, 3]);
  assert.equal(state.width, 3);
});

test("accepts a plain array and works without dims", () => {
  const { state, process: onLogits } = makeLogitCapture();
  onLogits([], { data: [0, 1, 2] });
  assert.deepEqual(Array.from(state.row), [0, 1, 2]);
  assert.equal(state.width, 3);
});

test("survives a step with no logits and still counts steps", () => {
  const { state, process: onLogits } = makeLogitCapture();
  assert.doesNotThrow(() => onLogits([], undefined));
  onLogits([], { data: [], dims: [1, 0] });
  assert.equal(state.row, null);
  assert.equal(state.steps, 2);
});

test("a captured row feeds verdictStats with the YES-vs-NO margin intact", () => {
  // Four-token vocabulary where id 2 is YES and id 3 is NO; YES is the argmax.
  const logits = Float32Array.from([0, 0, 3, 1]);
  const { state, process: onLogits } = makeLogitCapture();
  onLogits([], { data: logits, dims: [1, 4] });

  const stats = verdictStats([state.row], [2], { yes: 2, no: 3 });
  const lse = 2 + Math.exp(3) + Math.exp(1);
  assert.equal(stats.steps, 1);
  assert.equal(stats.firstTokenProb.toFixed(6), (Math.exp(3) / lse).toFixed(6));
  assert.ok(stats.yesProb > stats.noProb);
  // Renormalised over the two verdicts only: e^3 / (e^3 + e) ≈ 0.881.
  assert.ok(stats.verdictProb > 0.85 && stats.verdictProb < 0.9, `got ${stats.verdictProb}`);
});

test("no capture means no invented confidence", () => {
  const { state } = makeLogitCapture();
  assert.equal(state.row, null);
  // This is the shape the worker posts when nothing was captured: null, not a
  // number that happens to read as certainty.
  assert.equal(verdictStats(state.row ? [state.row] : null, [2], { yes: 2, no: 3 }), null);
});
