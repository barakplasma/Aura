// Aura — aggregates transformers.js's per-file download progress events into
// one running, monotonically increasing percentage. Used only by
// src/workers/ml.worker.js; pulled out as a pure module so the aggregation
// math (the actual fix for the progress bar jumping backward between files)
// is unit-testable without a Worker or a real model load.

export function createProgressState() {
  return { loadedByFile: new Map(), totalByFile: new Map() };
}

// Records one transformers.js progress/download event's numbers for its file.
export function recordProgress(state, { file, loaded = 0, total = 0 }) {
  state.loadedByFile.set(file, loaded);
  if (total > 0) state.totalByFile.set(file, total);
}

// Returns the running { loaded, total, pct } across every file seen so far.
// `expectedTotal`, when known (see lib/model-size.js), pins the denominator
// so pct can only go up as bytes arrive — without it, the denominator grows
// each time a new file's size becomes known, which can make pct dip.
export function aggregateProgress(state, expectedTotal) {
  const sumLoaded = sum(state.loadedByFile.values());
  const grandTotal = expectedTotal ?? sum(state.totalByFile.values());
  const pct = grandTotal > 0 ? Math.min(100, Math.round((sumLoaded / grandTotal) * 100)) : null;
  return { loaded: sumLoaded, total: grandTotal, pct };
}

function sum(iterable) {
  let total = 0;
  for (const n of iterable) total += n;
  return total;
}
