// A thin progress/countdown bar for the scan cycle.
//   phase "processing" — amber, filling toward the model's estimated finish
//   phase "waiting"    — green, counting down to the next capture
// When `pct` is null the phase is indeterminate (no latency history yet) and an
// animated sweep plays instead of a fixed fill.
export default function ProgressBar({ phase, pct, label }) {
  const known = Number.isFinite(pct);
  return (
    <div className="scan-progress">
      <div
        className={`scan-progress-track ${phase}${known ? '' : ' indeterminate'}`}
        role="progressbar"
        aria-valuenow={known ? Math.round(pct) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label || 'Scan progress'}
      >
        <div className="scan-progress-fill" style={known ? { width: `${pct}%` } : undefined} />
      </div>
      {label && <span className="scan-progress-label">{label}</span>}
    </div>
  );
}

// Shared label formatter so the stage and the controls panel read the same.
export function progressLabel(progress) {
  if (!progress || progress.phase === 'idle') return '';
  const secs = Number.isFinite(progress.etaMs) ? (progress.etaMs / 1000).toFixed(1) : null;
  if (progress.phase === 'processing') {
    return secs != null ? `PROCESSING — ~${secs}s LEFT` : 'PROCESSING…';
  }
  return secs != null ? `NEXT FRAME IN ${secs}s` : 'NEXT FRAME…';
}
