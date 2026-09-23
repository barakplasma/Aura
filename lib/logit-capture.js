// Capture the logits a generation loop produces and then throws away.
//
// Why a logits *processor* rather than the obvious option: `output_scores` is
// what you would reach for, and transformers.js 4.3 accepts it while ignoring
// it. The option is not implemented anywhere in its `src/`, and its generation
// loop hands each step's logits to the sampler only
// (node_modules/@huggingface/transformers/src/models/modeling_utils.js:1025).
// So `generate({ output_scores: true })` returns a bare token Tensor, and a
// caller unpacking `[tokens, scores]` gets `scores === null` without an error.
// That is why every scan on the reference Pixel 7a reported `logits: null`,
// which pushed alert confidence back to parseLooseDetection()'s default of 100
// — not the tokenizer, not the execution provider, and nothing in the app said
// so.
//
// User processors are appended *after* the library's own
// (`processors.extend(logits_processor)` in that same file), so adding one does
// not displace `repetition_penalty` or any other default the worker relies on.
//
// A plain function is enough, and the shape matters: measured against
// Xenova/gpt2 in Node, `logits_processor: [fn]` fired once per decode step
// (4/4 and 2/2 steps, `logits.dims = [1, 50257]`), while the same processor
// wrapped in a `LogitsProcessorList` fired **0** times — the list is silently
// dropped. Two further dead ends, measured on that same model:
// `generate({ output_scores: true })` returned a bare token Tensor, and
// `generate({ return_dict_in_generate: true, output_scores: true })` returned
// an object whose keys were `sequences` and `past_key_values` — there is no
// scores key to read.
//
// Deliberately dependency-free (see the bundle rule in CLAUDE.md): @huggingface/
// transformers must stay out of everything except src/workers/ml.worker.js, so
// this file takes the logits as a duck-typed `{ data, dims }` and could equally
// serve a different inference backend.

/**
 * @returns {{ state: { row: Float32Array|null, steps: number, width: number },
 *             process: (inputIds: unknown, logits: {data: ArrayLike<number>, dims?: number[]}) => unknown }}
 *          `process` goes into `logits_processor: [process]`; read `state`
 *          after `generate()` resolves.
 */
export function makeLogitCapture() {
  const state = {
    /** Vocabulary row of the *first* decode step — where a terse answer commits
     *  to YES or NO. Null until a step has been seen. */
    row: null,
    /** Decode steps observed, so a model that rambles for 40 tokens is
     *  distinguishable from one that answered in one. */
    steps: 0,
    /** Row width actually copied. */
    width: 0,
  };

  return {
    state,
    process(_inputIds, logits) {
      state.steps++;
      const data = logits?.data;
      if (!state.row && data?.length) {
        // dims are [batch, vocab]. The worker always generates at batch 1, but
        // bounding the copy to one row keeps a batched call from quietly
        // folding two vocabulary rows into one probability.
        const width = logits.dims?.at(-1) ?? data.length;
        const src =
          typeof data.subarray === "function" ? data.subarray(0, width) : Array.from(data).slice(0, width);
        // Copy, don't alias: the loop reuses the buffer for the next step.
        state.row = Float32Array.from(src);
        state.width = state.row.length;
      }
      return logits; // pass through; this processor changes nothing
    },
  };
}
