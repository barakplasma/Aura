import { test } from "node:test";
import assert from "node:assert/strict";
import { logSumExp, verdictStats, singleTokenId } from "../lib/logprob.js";

// Measured on the reference phone (Pixel 7a, SmolVLM2 500M): the model answered
// a bare "YES" for a mission whose object was not in frame, and the alert stored
// conf 100. These helpers turn the generation's own logits into a number that
// actually moves, so the sensitivity slider has something to act on.

test("logSumExp matches a direct softmax denominator", () => {
  assert.ok(Math.abs(logSumExp([2, 1, 0]) - Math.log(Math.exp(2) + Math.exp(1) + 1)) < 1e-9);
});

test("logSumExp stays finite for logits far above zero", () => {
  // exp(1000) overflows a double; the max-shift must keep this usable.
  assert.ok(Number.isFinite(logSumExp([1000, 999, 1000.5])));
});

test("verdictStats reports first-token and mean token probability", () => {
  const stats = verdictStats([[2, 1, 0], [0, 3, 1]], [0, 1]);
  assert.equal(stats.steps, 2);
  assert.ok(Math.abs(stats.firstTokenProb - Math.exp(2) / (Math.exp(2) + Math.exp(1) + 1)) < 1e-9);
  const p0 = Math.exp(2) / (Math.exp(2) + Math.exp(1) + 1);
  const p1 = Math.exp(3) / (1 + Math.exp(3) + Math.exp(1));
  assert.ok(Math.abs(stats.meanTokenProb - (p0 + p1) / 2) < 1e-9);
});

test("verdictStats reads ONNX tensors and BigInt token ids", () => {
  const plain = verdictStats([[2, 1, 0], [0, 3, 1]], [0, 1]);
  const tensorish = verdictStats(
    [{ data: Float32Array.from([2, 1, 0]) }, { data: Float32Array.from([0, 3, 1]) }],
    BigInt64Array.from([0n, 1n]),
  );
  assert.equal(tensorish.firstTokenProb, plain.firstTokenProb);
  assert.equal(tensorish.steps, plain.steps);
});

test("verdictProb renormalises over YES against NO only", () => {
  // Other continuations ("The", "A", …) hold most of the mass in a real
  // generation; the slider compares the two verdicts, not the whole row.
  const stats = verdictStats([[2, 1, 0], [0, 3, 1]], [0, 1], { yes: 1, no: 2 });
  const py = Math.exp(1) / (Math.exp(2) + Math.exp(1) + 1);
  const pn = 1 / (Math.exp(2) + Math.exp(1) + 1);
  assert.ok(Math.abs(stats.yesProb - py) < 1e-9);
  assert.ok(Math.abs(stats.noProb - pn) < 1e-9);
  assert.ok(Math.abs(stats.verdictProb - py / (py + pn)) < 1e-9);
  assert.ok(stats.verdictProb > 0.5 && stats.verdictProb < 1);
});

test("verdictStats returns null when there is nothing to score", () => {
  assert.equal(verdictStats([], []), null);
  assert.equal(verdictStats(null, [1]), null);
  // An id outside the row cannot be scored; a row that scores nothing is null
  // rather than a confidence of 0, which would silence alerts for a format bug.
  assert.equal(verdictStats([[1, 2]], [7]), null);
});

test("singleTokenId takes only single-token encodings", () => {
  const one = (word) => (s, o) => {
    assert.deepEqual(o, { add_special_tokens: false });
    return { input_ids: s === word ? [9137] : [9137, 310] };
  };
  assert.equal(singleTokenId(one("YES"), "YES"), 9137);
  assert.equal(singleTokenId(one("nothing"), "YES"), null);
});

test("singleTokenId resolves title case — the casing SmolVLM2 actually answers in", () => {
  // Measured on the reference phone: the model answered "Yes" while the
  // upper/lower lookups found ids it never emits, so the margin read 98.8% NO
  // against a literal "Yes" in the text. "YES" itself is not single-token
  // here; only "Yes" is — and the lookup must find it.
  const vocab = { YES: [91, 37], yes: [91, 37], Yes: [10407] };
  const tok = (s, o) => {
    assert.deepEqual(o, { add_special_tokens: false });
    return { input_ids: vocab[s] || [9137, 310] };
  };
  assert.equal(singleTokenId(tok, "YES"), 10407);
});

test("singleTokenId survives a tokenizer that throws", () => {
  assert.equal(singleTokenId(() => { throw new Error("no tokenizer here"); }, "NO"), null);
});
