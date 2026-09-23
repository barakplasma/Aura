// A repetition penalty that only sees what the model has generated.
//
// transformers.js's own `repetition_penalty` (RepetitionPenaltyLogitsProcessor
// in 4.3) iterates `all_input_ids`, which includes the prompt. On the detection
// leg that penalised the very tokens the prompt asks for — YES, NO,
// Confidence, Explanation — at the step where the verdict is chosen, and the
// logit capture then measured the penalised row. On the prose legs it
// discouraged the mission's own nouns. Loops are a property of the output, so
// the penalty looks only past `promptLength`.
//
// Same arithmetic as the library's: a positive logit is divided by the
// penalty, a negative one multiplied, once per distinct token. Dependency-free
// and duck-typed on `{ data, dims }`, like lib/logit-capture.js, so
// @huggingface/transformers stays inside the worker.

/**
 * @param {number} promptLength tokens of prompt (image tokens included) that
 *   precede the generated ones in each `inputIds` row.
 * @param {number} penalty > 1 discourages repeats; 1 is a no-op.
 * @returns {(inputIds: ArrayLike<ArrayLike<bigint|number>>, logits: {data: Float32Array, dims?: number[]}) => unknown}
 *   a plain function for `logits_processor: [fn]`.
 */
export function generatedRepetitionPenalty(promptLength, penalty) {
  return (inputIds, logits) => {
    if (!(penalty > 0) || penalty === 1) return logits;
    const data = logits?.data;
    if (!data?.length) return logits;
    const width = logits.dims?.at(-1) ?? data.length;
    const rows = inputIds?.length ?? 0;
    for (let b = 0; b < rows; b++) {
      const offset = b * width;
      if (offset + width > data.length) break;
      const seen = new Set();
      const ids = inputIds[b];
      for (let i = promptLength; i < (ids?.length ?? 0); i++) seen.add(Number(ids[i]));
      for (const token of seen) {
        if (token < 0 || token >= width) continue;
        const k = offset + token;
        data[k] = data[k] < 0 ? data[k] * penalty : data[k] / penalty;
      }
    }
    return logits;
  };
}
