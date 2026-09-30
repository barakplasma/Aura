import { cn } from '../ui/cn.js';

// A thin progress/countdown bar for the scan cycle.
//   phase "processing" — amber, filling toward the model's estimated finish
//   phase "waiting"    — green, counting down to the next capture
// When `pct` is null the phase is indeterminate (no latency history yet) and an
// animated sweep plays instead of a fixed fill.
export default function ProgressBar({ phase, pct, label }) {
  const known = Number.isFinite(pct);
  return (
    <div className="flex flex-col gap-1">
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-bg-2"
        role="progressbar"
        aria-valuenow={known ? Math.round(pct) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label || 'Scan progress'}
      >
        <div
          className={cn(
            'h-full rounded-full',
            phase === 'processing' ? 'bg-warn' : 'bg-ok',
            known ? 'transition-[width]' : 'w-2/5 animate-sweep',
          )}
          style={known ? { width: `${pct}%` } : undefined}
        />
      </div>
      {label && <span className="text-xs text-text-dim">{label}</span>}
    </div>
  );
}

// Shared label formatter so the stage and the controls panel read the same.
export function progressLabel(progress) {
  if (!progress || progress.phase === 'idle') return '';
  const secs = Number.isFinite(progress.etaMs) ? (progress.etaMs / 1000).toFixed(1) : null;
  if (progress.phase === 'processing') {
    const labels = {
      loading: 'Loading model',
      detecting: 'Detecting',
      announcing: 'Generating announcement',
      webhook: 'Generating webhook',
    };
    const label = labels[progress.stage] || 'Processing';
    if (progress.overrun) {
      const elapsed = (progress.elapsedMs / 1000).toFixed(1);
      return `${label} — taking longer than usual · ${elapsed}s elapsed`;
    }
    return secs != null ? `${label} — ~${secs}s left` : `${label}…`;
  }
  return secs != null ? `Next frame in ${secs}s` : 'Next frame…';
}
