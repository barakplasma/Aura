import { scanClient } from "./aura.js";

export function comboKey(model, variantId) {
  return `${model}::${variantId}`;
}

export function expandMatrix({ imageIds, models, variants }) {
  if (!Array.isArray(imageIds) || imageIds.length === 0) {
    throw new Error("At least one image is required.");
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("At least one model is required.");
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error("At least one prompt variant is required.");
  }

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
  const total = cells.length;
  const results = new Array(total);
  let cursor = 0;
  let done = 0;
  const workerCount = Math.max(
    1,
    Math.min(Number(concurrency) || 1, total || 1),
  );

  function emit(index, result) {
    if (results[index]) return;
    results[index] = result;
    done++;
    if (onResult) onResult(result, done, total);
  }

  async function worker() {
    while (!signal?.aborted) {
      const index = cursor++;
      if (index >= cells.length) return;
      const cell = cells[index];
      const variant = variantsById[cell.variantId];
      const image = imagesById[cell.imageId];

      if (!variant || !image) {
        emit(index, {
          ...cell,
          status: "error",
          error: !variant
            ? "Prompt variant not found."
            : "Sample image not found.",
        });
        continue;
      }

      try {
        const result = await scanFn({
          baseUrl,
          apiKey,
          model: cell.model,
          mission: variant.mission,
          image: image.dataUrl,
          threshold: 0,
          optimizedInstruction: variant.instruction || undefined,
          requestTimeout,
          signal,
        });
        if (signal?.aborted) {
          emit(index, { ...cell, status: "cancelled" });
        } else {
          emit(index, {
            ...cell,
            status: "ok",
            triggered: Boolean(result.triggered),
            confidence: Number.isFinite(result.confidence)
              ? result.confidence
              : 0,
            reason: result.reason || "",
            latencyMs: result.latencyMs,
            usage: result.usage || null,
          });
        }
      } catch (err) {
        emit(index, {
          ...cell,
          status:
            signal?.aborted || err?.name === "AbortError"
              ? "cancelled"
              : "error",
          error: err?.message || "Evaluation call failed.",
        });
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  for (let i = 0; i < cells.length; i++) {
    if (!results[i]) emit(i, { ...cells[i], status: "cancelled" });
  }

  return results;
}

export function summarizeResults(results, expectedByImage = {}, rate = 0) {
  const combosByKey = new Map();
  const numericRate = parseFloat(rate) || 0;
  const totals = {
    n: results.length,
    ok: 0,
    errorCount: 0,
    cancelledCount: 0,
    totalTokens: 0,
    estCost: 0,
  };

  for (const r of results) {
    const key = comboKey(r.model, r.variantId);
    if (!combosByKey.has(key)) {
      combosByKey.set(key, {
        model: r.model,
        variantId: r.variantId,
        n: 0,
        ok: 0,
        errorCount: 0,
        triggeredCount: 0,
        meanLatencyMs: null,
        totalTokens: 0,
        estCost: 0,
        labeled: null,
        _latencySum: 0,
        _labeled: {
          n: 0,
          correct: 0,
          tp: 0,
          fp: 0,
          fn: 0,
          tn: 0,
          confidenceGapSum: 0,
        },
      });
    }

    const combo = combosByKey.get(key);
    combo.n++;
    if (r.status === "ok") {
      combo.ok++;
      totals.ok++;
      if (r.triggered) combo.triggeredCount++;
      if (Number.isFinite(r.latencyMs)) combo._latencySum += r.latencyMs;
      const tokens = usageTokens(r.usage);
      combo.totalTokens += tokens;
      totals.totalTokens += tokens;

      const expected = expectedByImage[r.imageId];
      if (expected === true || expected === false) {
        const labeled = combo._labeled;
        const predicted = Boolean(r.triggered);
        labeled.n++;
        if (predicted === expected) labeled.correct++;
        if (predicted && expected) labeled.tp++;
        else if (predicted && !expected) labeled.fp++;
        else if (!predicted && expected) labeled.fn++;
        else labeled.tn++;
        const target = expected ? 100 : 0;
        const confidence = Number.isFinite(r.confidence) ? r.confidence : 0;
        labeled.confidenceGapSum += Math.abs(confidence - target);
      }
    } else if (r.status === "cancelled") {
      totals.cancelledCount++;
    } else {
      combo.errorCount++;
      totals.errorCount++;
    }
  }

  const combos = Array.from(combosByKey.values()).map((combo) => {
    combo.meanLatencyMs =
      combo.ok > 0 ? Math.round(combo._latencySum / combo.ok) : null;
    combo.estCost = (combo.totalTokens / 1e6) * numericRate;
    if (combo._labeled.n > 0) {
      combo.labeled = {
        n: combo._labeled.n,
        correct: combo._labeled.correct,
        accuracy: combo._labeled.correct / combo._labeled.n,
        tp: combo._labeled.tp,
        fp: combo._labeled.fp,
        fn: combo._labeled.fn,
        tn: combo._labeled.tn,
        meanAbsConfidenceGap:
          combo._labeled.confidenceGapSum / combo._labeled.n,
      };
    }
    delete combo._latencySum;
    delete combo._labeled;
    return combo;
  });

  totals.estCost = (totals.totalTokens / 1e6) * numericRate;
  return { combos, totals };
}

function usageTokens(usage) {
  return usage && Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0;
}
