import { useEffect, useState } from 'react';
import { ChevronDown, Copy } from 'lucide-react';
import { cn } from '../ui/cn.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Chip } from '../ui/chip.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.jsx';
import { Sheet } from '../ui/sheet.jsx';
import ProgressBar, { progressLabel } from './ProgressBar.jsx';

const STATE = {
  idle: { word: 'Ready', dot: 'bg-text-dim' },
  starting: { word: 'Starting', dot: 'bg-info' },
  watching: { word: 'Watching', dot: 'bg-ok' },
  alert: { word: 'Alert', dot: 'bg-danger' },
  degraded: { word: 'Degraded', dot: 'bg-warn' },
  error: { word: 'Error', dot: 'bg-danger' },
  stopped: { word: 'Stopped', dot: 'bg-text-dim' },
  background: { word: 'Background', dot: 'bg-warn' },
};
const ENGINE = { provider: 'Provider', browser: 'In-browser', decision: 'Decision' };
const RECENT_DOT = { alert: 'bg-danger', degraded: 'bg-warn', watching: 'bg-ok' };

function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function relativeTime(then, now) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`;
}

// The result of the last scan, as structure rather than a sentence: state,
// headline, confidence against the threshold, engine degradation, why, what's
// next. While idle the same card is the empty state.
export default function VerdictCard({ verdict, running, progress, recent, modelLabel, onDemo, onFix, onOpenEntry }) {
  const [sheet, setSheet] = useState(false);
  const now = useNow(running);
  const meta = STATE[verdict.state] || STATE.idle;
  const empty = !running && (verdict.state === 'idle' || verdict.state === 'stopped');
  const showProgress = running && progress && progress.phase !== 'idle';
  const hasConfidence = verdict.confidence != null;
  const why = verdict.reason && verdict.reason !== verdict.headline ? verdict.reason : null;
  const engine = ENGINE[verdict.engine];

  return (
    <Card data-verdict={verdict.state} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('size-3 shrink-0 rounded-full', meta.dot)} aria-hidden />
        <span className="font-semibold">{meta.word}</span>
        {!empty && <span className="text-xs text-text-dim">{relativeTime(verdict.at, now)}</span>}
        {engine && (
          <Chip className="ml-auto">{engine}{modelLabel ? ` · ${modelLabel}` : ''}</Chip>
        )}
      </div>

      {empty ? (
        <>
          <p className="text-base">Point the camera, describe what to watch for, then arm.</p>
          <div>
            <Button variant="outline" onClick={onDemo}>Try demo</Button>
          </div>
        </>
      ) : (
        <p
          className={cn('text-base font-semibold break-words select-text', verdict.state === 'alert' && 'text-danger')}
          role="status"
          aria-live="polite"
        >
          {verdict.headline}
        </p>
      )}

      {hasConfidence && (
        <div className="flex items-center gap-3">
          <div
            className="relative h-2 flex-1 rounded-full bg-bg-2"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(verdict.confidence)}
            aria-label="Confidence"
          >
            <div
              className={cn('h-full rounded-full', verdict.confidence >= verdict.threshold ? 'bg-accent' : 'bg-text-dim')}
              style={{ width: `${Math.min(100, Math.max(0, verdict.confidence))}%` }}
            />
            {verdict.threshold > 0 && (
              <div
                className="absolute -top-1 h-4 w-0.5 bg-text"
                style={{ left: `${verdict.threshold}%` }}
                title={`Threshold ${verdict.threshold}%`}
              />
            )}
          </div>
          <span className="text-sm">
            {Math.round(verdict.confidence)}%
            {verdict.threshold > 0 && <span className="text-text-dim"> / {verdict.threshold}%</span>}
          </span>
        </div>
      )}

      {verdict.note && (
        <button
          type="button"
          className="flex min-h-11 items-center gap-2 rounded-md bg-warn/15 px-3 text-left text-sm text-warn"
          onClick={() => setSheet(true)}
        >
          <span className="flex-1">{verdict.note.text}</span>
          <span className="text-xs underline">Details</span>
        </button>
      )}

      {verdict.error?.fixField && (
        <div>
          <Button variant="outline" onClick={() => onFix(verdict.error.fixField)}>Fix in Setup</Button>
        </div>
      )}

      {why && (
        <Collapsible defaultOpen={verdict.state === 'alert'} key={verdict.at}>
          <CollapsibleTrigger className="flex min-h-11 items-center gap-1 text-sm text-text-dim">
            <ChevronDown className="size-4" aria-hidden />Why
          </CollapsibleTrigger>
          <CollapsibleContent className="text-sm break-words select-text">{why}</CollapsibleContent>
        </Collapsible>
      )}

      {showProgress && (
        <ProgressBar phase={progress.phase} pct={progress.pct} label={progressLabel(progress)} />
      )}

      {recent.length > 0 && (
        <div className="flex items-center gap-2" aria-label="Last scans">
          <span className="text-xs text-text-dim">Last {recent.length}</span>
          {recent.map((r) => (
            r.entryId != null ? (
              <button
                key={r.at}
                type="button"
                className="grid size-11 place-items-center"
                aria-label={`Open this ${r.state === 'alert' ? 'alert' : 'scan'} in Alerts`}
                onClick={() => onOpenEntry(r.entryId)}
              >
                <span className={cn('size-3 rounded-full', RECENT_DOT[r.state])} />
              </button>
            ) : (
              <span key={r.at} className={cn('size-3 rounded-full', RECENT_DOT[r.state])} title={r.state} />
            )
          ))}
        </div>
      )}

      <Sheet open={sheet} onOpenChange={setSheet} title={verdict.note?.text || 'Details'}>
        <pre className="max-h-64 overflow-auto rounded-md bg-bg-0 p-3 text-xs break-words whitespace-pre-wrap select-text">
          {verdict.note?.detail}
        </pre>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => navigator.clipboard?.writeText(verdict.note?.detail || '').catch(() => {})}
          >
            <Copy className="size-4" aria-hidden />Copy
          </Button>
          <Button variant="ghost" onClick={() => setSheet(false)}>Close</Button>
        </div>
      </Sheet>
    </Card>
  );
}
