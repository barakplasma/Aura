#!/usr/bin/env node
// Dev instrument: which BROWSER_MODELS rows can carry logit-derived
// confidence at all, measured from the real tokenizers, no phone required.
//
// Why: the worker reads the probability the model placed on its own first
// generated token (lib/logprob.js) as the fallback confidence when the answer
// carries no number, and `verdictStats` only reports the YES-vs-NO margin when
// it was handed `verdictIds`. Those ids come from `singleTokenId()`, which
// returns null whenever the word needs more than one token — so a family whose
// vocabulary has no single "YES" silently loses the margin column, and on the
// reference phone every scan reported `logitYES=-` with no explanation.
//
// Also measures what the compact prompt's labelled format costs in tokens:
// `Confidence: 90,` is two tokens on some vocabularies and eight on others, and
// that is paid on every scan.
//
// Downloads tokenizer files only (no weights), ~10-20 MB per model.
//   node scripts/dev-tokenizer-probe.mjs
//   WORDS=YES,NO,maybe node scripts/dev-tokenizer-probe.mjs
"use strict";

import { AutoTokenizer } from "@huggingface/transformers";
import { singleTokenId } from "../lib/logprob.js";
import { BROWSER_MODELS } from "../lib/browser-models.js";

const WORDS = (process.env.WORDS || "YES,NO,yes,no").split(",").filter(Boolean);
const ONLY = (process.env.MODELS || Object.keys(BROWSER_MODELS).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// The labelled format the compact detection prompt asks the model for, measured
// as it would actually be emitted rather than as bare words.
const FORMAT_PIECES = ["YES,", "NO,", "Confidence: 90,", "Explanation: a stack of books"];

const rows = [];
for (const key of ONLY) {
  const spec = BROWSER_MODELS[key];
  if (!spec) {
    rows.push({ key, error: "not in BROWSER_MODELS" });
    continue;
  }
  const row = { key, model: spec.modelId, promptProfile: spec.promptProfile };
  try {
    const t = await AutoTokenizer.from_pretrained(spec.modelId);
    const ids = {};
    for (const word of WORDS) ids[word] = singleTokenId(t, word);
    row.verdictIds = ids;
    // A verdict with no single token id can still be *read* (the parser works on
    // text); it just cannot be *scored* head-to-head, so `verdictProb` stays
    // null for that row forever.
    row.scorable = WORDS.slice(0, 2).every((w) => ids[w] != null) ? "yes" : "NO";
    const ntok = (s) => {
      const enc = t(s, { add_special_tokens: false });
      return (enc.input_ids.data ?? enc.input_ids).length;
    };
    row.formatTokens = Object.fromEntries(FORMAT_PIECES.map((p) => [p, ntok(p)]));
  } catch (err) {
    row.error = String(err?.message || err).slice(0, 120);
  }
  rows.push(row);
  console.log(JSON.stringify(row));
}

console.table(
  rows.map((r) => ({
    key: r.key,
    profile: r.promptProfile ?? "-",
    YES: r.verdictIds?.YES ?? r.error ?? "-",
    NO: r.verdictIds?.NO ?? "-",
    yes: r.verdictIds?.yes ?? "-",
    no: r.verdictIds?.no ?? "-",
    scorable: r.scorable ?? "-",
    "Confidence:_90": r.formatTokens?.["Confidence: 90,"] ?? "-",
    "Explanation:_text": r.formatTokens?.["Explanation: a stack of books"] ?? "-",
  })),
);

const unscorable = rows.filter((r) => r.scorable === "NO");
if (unscorable.length)
  console.log(
    `\nUnscorable rows (no single-token verdict, so no margin column — rely on the ` +
      `model's own Confidence number instead): ${unscorable.map((r) => r.key).join(", ")}`,
  );
