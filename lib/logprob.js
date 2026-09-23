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
 * `verdictIds` — optional `{ yes, no }`, each a single-token id or a list of
 *               them (every casing that encodes as one token), used to report
 *               the head-to-head margin at the step where the verdict was
 *               emitted.
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
  const yes = idList(verdictIds?.yes);
  const no = idList(verdictIds?.no);
  if (yes.length && no.length) {
    const logits = row(0);
    if (logits && logits.length > Math.max(...yes, ...no)) {
      const lse = logSumExp(logits);
      // Summed over every casing: a model that answers "Yes" and one that
      // answers "YES" are giving the same verdict, and scoring only one
      // casing reads the other as NO.
      const mass = (ids) => ids.reduce((sum, id) => sum + Math.exp(logits[id] - lse), 0);
      const py = mass(yes);
      const pn = mass(no);
      out.yesProb = py;
      out.noProb = pn;
      // Renormalised over the two verdicts only: the model spends probability
      // on other continuations too, and the slider compares YES against NO.
      out.verdictProb = py + pn > 0 ? py / (py + pn) : py;
      // Whether the first emitted token *is* a verdict. When it is not (a
      // JSON "{", a caption's "The"), the margin was read at a step where no
      // verdict was being chosen and must not be used as a confidence.
      const first = Number(emitted[0]);
      out.verdictAtFirstStep = yes.includes(first) || no.includes(first);
    }
  }
  return out;
}

function idList(ids) {
  if (ids == null) return [];
  return (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
}

const casings = (word) => {
  const lower = word.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  return [word, ` ${word}`, lower, ` ${lower}`, title, ` ${title}`];
};

function encodeOne(tokenizer, variant) {
  try {
    const enc = tokenizer(variant, { add_special_tokens: false });
    const ids = enc?.input_ids?.data ?? enc?.input_ids;
    return ids && ids.length === 1 ? Number(ids[0]) : null;
  } catch {
    // Tokenizer shape differs per family; a miss just means no margin column.
    return null;
  }
}

/**
 * Resolve a word to a single vocabulary id, or null when it needs more than
 * one token (in which case a per-token probability cannot be read for it).
 * Returns the first casing that encodes as one token; see verdictTokenIds()
 * for the full set, which is what the margin should be summed over.
 */
export function singleTokenId(tokenizer, word) {
  for (const variant of casings(word)) {
    const id = encodeOne(tokenizer, variant);
    if (id != null) return id;
  }
  return null;
}

/**
 * Every single-token id the word can arrive as — upper, lower and title case,
 * with and without the leading space byte-pair vocabularies usually encode.
 * SmolVLM2 answers "Yes" while the prompt says "YES"; returning only the first
 * hit scored the casing the model did not emit.
 */
export function verdictTokenIds(tokenizer, word) {
  const ids = new Set();
  for (const variant of casings(word)) {
    const id = encodeOne(tokenizer, variant);
    if (id != null) ids.add(id);
  }
  return [...ids];
}

/**
 * The confidence a detection should carry when the worker returned logits, or
 * null to keep the parsed one. Confidence here is P(condition met), the same
 * scale parseLooseDetection() defaults to (YES → high, NO → low), taken from
 * the YES-vs-NO margin at the first decode step.
 *
 * The margin beats a number the model wrote: a 500M model's written
 * "Confidence: 90" is itself generated text, and was measured to claim
 * certainty for objects that were not in frame. It is only used when the
 * first emitted token was a verdict — otherwise it measured nothing.
 */
export function logitConfidence(logits) {
  if (!logits?.verdictAtFirstStep) return null;
  const p = logits.verdictProb;
  return Number.isFinite(p) ? Math.round(100 * p) : null;
}
