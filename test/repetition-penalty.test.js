import test from "node:test";
import assert from "node:assert/strict";
import { generatedRepetitionPenalty } from "../lib/repetition-penalty.js";

// transformers.js's repetition_penalty covers the prompt too, which on the
// detection leg pushed down the YES/NO tokens the prompt itself names. This one
// must only ever touch tokens the model generated.

test("prompt tokens are not penalised; generated ones are", () => {
  const penalise = generatedRepetitionPenalty(3, 2);
  // Prompt = [0, 1, 2]; generated so far = [3].
  const logits = { data: Float32Array.from([4, 4, 4, 4, -4]), dims: [1, 5] };
  const out = penalise([[0n, 1n, 2n, 3n]], logits);
  assert.equal(out, logits, "passes the same logits object through");
  assert.deepEqual(Array.from(logits.data), [4, 4, 4, 2, -4]);
});

test("same sign arithmetic as the library: negatives are pushed further down", () => {
  const penalise = generatedRepetitionPenalty(1, 2);
  const logits = { data: Float32Array.from([1, -3, 5]), dims: [1, 3] };
  penalise([[2n, 1n, 1n]], logits); // token 1 generated twice — penalised once
  assert.deepEqual(Array.from(logits.data), [1, -6, 5]);
});

test("a penalty of 1 (or nothing generated yet) changes nothing", () => {
  const logits = { data: Float32Array.from([1, 2, 3]), dims: [1, 3] };
  generatedRepetitionPenalty(0, 1)([[0n, 1n]], logits);
  generatedRepetitionPenalty(2, 1.5)([[0n, 1n]], logits);
  assert.deepEqual(Array.from(logits.data), [1, 2, 3]);
});

test("ids outside the vocabulary row are ignored", () => {
  const logits = { data: Float32Array.from([2, 2]), dims: [1, 2] };
  generatedRepetitionPenalty(0, 2)([[7n, 1n]], logits);
  assert.deepEqual(Array.from(logits.data), [2, 1]);
});
