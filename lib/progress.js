// Progress toward a latency estimate must never claim an overdue scan has
// zero time remaining: once it crosses the estimate, surface elapsed time.
export function processingProgress(elapsedMs, estimateMs) {
  const elapsed = Math.max(0, Math.round(elapsedMs || 0));
  const estimate = Math.max(0, Math.round(estimateMs || 0));
  const overrun = estimate > 0 && elapsed > estimate;
  return {
    pct: estimate > 0 ? Math.min(95, Math.round((elapsed / estimate) * 100)) : null,
    etaMs: estimate > 0 && !overrun ? Math.max(0, Math.round((estimate - elapsed) / 100) * 100) : null,
    elapsedMs: elapsed,
    estimateMs: estimate || null,
    overrun,
  };
}
