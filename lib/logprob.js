// Logit-derived confidence for on-device scans.
//
// Why this exists: a 500M VLM invents its own certainty. Measured on the
// reference Pixel 7a it answered a bare "YES" to every mission — including an
// object that was demonstrably not in frame — and the alert stored `conf: 100`.
// `parseLooseDetection()` also has to default to 100 when the answer carries no
// number, so the sensitivity slider could not change a verdict at any position.
//
// The probability the model placed on its own first generated token is real
// evidence. It is nearly free too — but only if you can reach the logits, and
// generation does not hand them back in transformers.js 4.3 (see
// lib/logit-capture.js for how they are taken from the decode loop instead).
// Engine code uses it only when the model supplied no number of its own, so a
// model that does report confidence keeps its own figure.

// log(sum(exp(x))) over a logits array/tensor, computed stably. Vocabularies
// here are 128k-150k wide, so this is the only pass over the row.
export function logSumExp(logits) {
  const n = logits?.length ?? 0;
  if (!n) return NaN;
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp(logits[i] - max);
  return max + Math.log(sum);
}

/**
 * Per-token quantities from one generate() pass.
 *
 * `scores`    — per-step logits, one vocabulary row per generated token. The
 *               worker supplies these from `makeLogitCapture()`
 *               (lib/logit-capture.js), which can only observe the steps the
 *               generation loop runs through the logits-processor chain, so in
 *               practice `scores.length === 1` — the first step, where a terse
 *               answer commits to YES or NO. Entries may be ONNX tensors
 *               (`.data`) or plain arrays.
 * `emitted`   — the generated token ids, prompt excluded.
 * `verdictIds` — optional `{ yes, no }` single-token ids, used to report the
 *               head-to-head margin at the step where the verdict was emitted.
 *
 * `firstTokenProb` is the number the alert path uses: the first generated token
 * of a terse answer is the verdict itself. `meanTokenProb` is reported next to
 * it so a rambling answer is visibly different from a decisive one, and a
 * degenerate one can be told apart from a genuinely uncertain model.
 */
export function verdictStats(scores, emitted, verdictIds = null) {
  const steps = Math.min(scores?.length ?? 0, emitted?.length ?? 0);
  if (!steps) return null;
  const row = (i) => {
    const s = scores[i];
    return s && s.data ? s.data : s;
  };
  const probs = [];
  for (let i = 0; i < steps; i++) {
    const logits = row(i);
    const id = Number(emitted[i]);
    if (!logits || logits.length <= id || !Number.isFinite(logits[id])) continue;
    probs.push(Math.exp(logits[id] - logSumExp(logits)));
  }
  if (!probs.length) return null;
  const mean = probs.reduce((a, b) => a + b, 0) / probs.length;
  const out = {
    firstTokenProb: probs[0],
    meanTokenProb: mean,
    steps: probs.length,
  };
  if (verdictIds?.yes != null && verdictIds?.no != null) {
    const logits = row(0);
    if (logits && logits.length > Math.max(verdictIds.yes, verdictIds.no)) {
      const lse = logSumExp(logits);
      const py = Math.exp(logits[verdictIds.yes] - lse);
      const pn = Math.exp(logits[verdictIds.no] - lse);
      out.yesProb = py;
      out.noProb = pn;
      // Renormalised over the two verdicts only: the model spends probability
      // on other continuations too, and the slider compares YES against NO.
      out.verdictProb = py + pn > 0 ? py / (py + pn) : py;
    }
  }
  return out;
}

/**
 * Resolve a word to a single vocabulary id, or null when it needs more than one
 * token (in which case a per-token probability cannot be read for it). Leading
 * space is tried because byte-pair vocabularies usually encode an
 * word-initial space into the token.
 */
export function singleTokenId(tokenizer, word) {
  for (const variant of [word, ` ${word}`, word.toLowerCase(), ` ${word.toLowerCase()}`]) {
    try {
      const enc = tokenizer(variant, { add_special_tokens: false });
      const ids = enc?.input_ids?.data ?? enc?.input_ids;
      if (ids && ids.length === 1) return Number(ids[0]);
    } catch {
      // Tokenizer shape differs per family; a miss just means no margin column.
    }
  }
  return null;
}
