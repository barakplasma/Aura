// Aura prompt-evaluation engine — pure helpers to run a matrix of
// (sample image × model × prompt variant) detection scans and score the
// results. Browser-compatible; fully Node-testable via the injectable scanFn.

import { scanClient } from "./aura.js";

// Expand the evaluation matrix into flat cell descriptors, model-major:
// all cells for one model run before the next model starts, which groups
// load per model and is gentler on per-model rate limits.
export function expandMatrix({ imageIds, models, variants }) {
  if (!imageIds?.length) throw new Error("At least one sample image is required.");
  if (!models?.length) throw new Error("At least one model is required.");
  if (!variants?.length) throw new Error("At least one prompt variant is required.");
  const cells = [];
  for (const model of models) {
    for (const variant of variants) {
      for (const imageId of imageIds) {
        cells.push({ imageId, model, variantId: variant.id });
      }
    }
  }
  return cells;
}

// Column key for a (model × variant) combo. NUL never appears in model names
// or variant ids, so the key is unambiguous.
export function comboKey(model, variantId) {
  return `${model}\u0000${variantId}`;
}

// Run every cell through a detection-only scan with a small worker pool.
// Per-cell failures are captured as results, not thrown; an abort via
// `signal` marks the remaining cells "cancelled" and RESOLVES with the
// partial results so the caller can persist them.
export async function runEvalMatrix({
  baseUrl,
  apiKey,
  cells,
  imagesById,
  variantsById,
  concurrency = 2,
  requestTimeout = 60,
  signal,
  onResult,
  scanFn = scanClient,
}) {
  const results = new Array(cells.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      if (signal?.aborted) return;
      const i = cursor;
      cursor += 1;
      if (i >= cells.length) return;
      const cell = cells[i];
      const image = imagesById[cell.imageId];
      const variant = variantsById[cell.variantId];
      let result;
      try {
        // No action/webhookAction/examples ⇒ exactly one detection call.
        // threshold 0 so `triggered` reflects the raw model verdict.
        const scan = await scanFn({
          baseUrl,
          apiKey,
          model: cell.model,
          mission: variant.mission,
          optimizedInstruction: variant.instruction || undefined,
          image: image.dataUrl,
          threshold: 0,
          requestTimeout,
          signal,
        });
        result = {
          ...cell,
          status: "ok",
          triggered: scan.triggered,
          confidence: scan.confidence,
          reason: scan.reason,
          latencyMs: scan.latencyMs,
          usage: scan.usage,
          error: null,
        };
      } catch (err) {
        // An in-flight request aborted by Cancel is a cancellation, not a
        // provider failure. No automatic retry in v1 — a single backoff
        // retry on 429 is the obvious extension.
        const cancelled = Boolean(signal?.aborted);
        result = {
          ...cell,
          status: cancelled ? "cancelled" : "error",
          triggered: null,
          confidence: null,
          reason: null,
          latencyMs: null,
          usage: null,
          error: cancelled ? null : String(err?.message || err),
        };
      }
      results[i] = result;
      done += 1;
      onResult?.(result, done, cells.length);
    }
  }

  const poolSize = Math.max(1, Math.min(concurrency, cells.length));
  await Promise.all(Array.from({ length: poolSize }, worker));

  // Cells never started (abort mid-run) still get a placeholder so the
  // results array always lines up 1:1 with the cells.
  for (let i = 0; i < cells.length; i++) {
    if (!results[i]) {
      results[i] = {
        ...cells[i],
        status: "cancelled",
        triggered: null,
        confidence: null,
        reason: null,
        latencyMs: null,
        usage: null,
        error: null,
      };
    }
  }
  return results;
}

// Aggregate results per (model × variant) combo. `expectedByImage` maps
// imageId → true/false/null; accuracy stats cover labeled ok cells only.
// `rate` is $/Mtok (same estimate as the live monitor's cost telemetry).
export function summarizeResults(results, expectedByImage = {}, rate = 0) {
  const byCombo = new Map();
  for (const r of results) {
    const key = comboKey(r.model, r.variantId);
    let agg = byCombo.get(key);
    if (!agg) {
      agg = {
        model: r.model,
        variantId: r.variantId,
        n: 0,
        ok: 0,
        errorCount: 0,
        triggeredCount: 0,
        latencySum: 0,
        latencyN: 0,
        totalTokens: 0,
        lab: { n: 0, correct: 0, tp: 0, fp: 0, fn: 0, tn: 0, gapSum: 0 },
      };
      byCombo.set(key, agg);
    }
    agg.n += 1;
    if (r.status === "error") agg.errorCount += 1;
    if (r.status !== "ok") continue;
    agg.ok += 1;
    if (r.triggered) agg.triggeredCount += 1;
    if (Number.isFinite(r.latencyMs)) {
      agg.latencySum += r.latencyMs;
      agg.latencyN += 1;
    }
    agg.totalTokens += r.usage?.total_tokens || 0;

    const expected = expectedByImage[r.imageId];
    if (expected === true || expected === false) {
      const predicted = Boolean(r.triggered);
      agg.lab.n += 1;
      if (predicted === expected) agg.lab.correct += 1;
      if (predicted && expected) agg.lab.tp += 1;
      else if (predicted && !expected) agg.lab.fp += 1;
      else if (!predicted && expected) agg.lab.fn += 1;
      else agg.lab.tn += 1;
      // How far the stated confidence sits from the ideal (100 when the
      // scene should trigger, 0 when it shouldn't).
      const conf = Number.isFinite(r.confidence) ? r.confidence : 0;
      agg.lab.gapSum += Math.abs(conf - (expected ? 100 : 0));
    }
  }

  const rateNum = parseFloat(rate) || 0;
  const combos = [...byCombo.values()].map((a) => ({
    model: a.model,
    variantId: a.variantId,
    n: a.n,
    ok: a.ok,
    errorCount: a.errorCount,
    triggeredCount: a.triggeredCount,
    meanLatencyMs: a.latencyN ? Math.round(a.latencySum / a.latencyN) : null,
    totalTokens: a.totalTokens,
    estCost: (a.totalTokens / 1e6) * rateNum,
    labeled: a.lab.n
      ? {
          n: a.lab.n,
          correct: a.lab.correct,
          accuracy: a.lab.correct / a.lab.n,
          tp: a.lab.tp,
          fp: a.lab.fp,
          fn: a.lab.fn,
          tn: a.lab.tn,
          meanAbsConfidenceGap: a.lab.gapSum / a.lab.n,
        }
      : null,
  }));

  const totals = combos.reduce(
    (t, c) => ({
      totalTokens: t.totalTokens + c.totalTokens,
      estCost: t.estCost + c.estCost,
      errorCount: t.errorCount + c.errorCount,
    }),
    { totalTokens: 0, estCost: 0, errorCount: 0 },
  );
  return { combos, totals };
}
