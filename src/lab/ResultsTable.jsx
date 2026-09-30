import { cn } from '../ui/cn.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { comboKey } from '../../lib/eval.js';
import { ExpectedBadge } from './SampleImages.jsx';
import { evalModelLabel } from './model-label.js';

const CELL = 'border border-border px-2 py-1 text-center align-middle whitespace-nowrap';
const HEAD = 'border border-border bg-bg-2 px-2 py-1 text-center font-semibold';

// One image × (model, variant) result.
function Cell({ result, expected }) {
  if (!result || result.status === 'cancelled') return <td className={CELL}>—</td>;
  if (result.status === 'error') {
    return <td className={cn(CELL, 'bg-danger/15 text-danger')} title={result.error}>Error</td>;
  }
  const labeled = expected === true || expected === false;
  const match = labeled ? Boolean(result.triggered) === expected : null;
  // Provenance in the hover: which runtime answered, on what device, and what
  // the one-time model load cost (browser cells only).
  const provenance = [
    result.reason,
    result.runtime && `runtime: ${result.runtime}`,
    result.device && `device: ${result.device}`,
    result.modelLoadMs != null && `model load: ${(result.modelLoadMs / 1000).toFixed(1)}s`,
  ].filter(Boolean).join(' · ');
  return (
    <td className={cn(CELL, match === true && 'bg-ok/15', match === false && 'bg-danger/15')} title={provenance || undefined}>
      <span className={result.triggered ? 'font-semibold text-warn' : 'text-text-dim'}>
        {result.triggered ? 'Trigger' : 'Clear'} {Math.round(result.confidence)}
      </span>
      <span className="ml-1 text-xs text-text-dim">{(result.latencyMs / 1000).toFixed(1)}s</span>
    </td>
  );
}

// The finished (or in-progress) run: a row per image, a column per model and
// prompt variant, and aggregate rows underneath.
export default function ResultsTable({ run, summary, imageById, onExport }) {
  const combos = run.models.flatMap((m) => run.variants.map((v) => ({ model: m, variant: v, key: comboKey(m, v.id) })));
  const cellByKey = new Map(run.results.map((r) => [`${r.imageId}|${comboKey(r.model, r.variantId)}`, r]));
  const agg = (c) => summary?.combos.find((x) => x.model === c.model && x.variantId === c.variant.id);
  const aggRow = (label, render) => (
    <tr>
      <th scope="row" className={cn(HEAD, 'text-left')}>{label}</th>
      {combos.map((c) => <td key={c.key} className={CELL}>{render(agg(c))}</td>)}
    </tr>
  );
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">
        Results — {new Date(run.at).toLocaleString()}{run.cancelled ? ' (cancelled)' : ''}
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th rowSpan={2} className={HEAD}>Image</th>
              {run.models.map((m) => {
                const { name, sub } = evalModelLabel(m);
                return (
                  <th key={m} colSpan={run.variants.length} className={HEAD}>
                    {name}{sub && <span className="font-normal text-text-dim"> · {sub}</span>}
                  </th>
                );
              })}
            </tr>
            <tr>
              {combos.map((c) => <th key={c.key} className={HEAD} title={c.variant.mission}>{c.variant.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {run.imageIds.map((imageId) => {
              const expected = run.expectedByImage?.[imageId] ?? null;
              return (
                <tr key={imageId}>
                  <th scope="row" className={cn(HEAD, 'font-normal')}>
                    {imageById[imageId]
                      ? <img src={imageById[imageId].dataUrl} alt="sample" className="mx-auto mb-1 h-12 rounded-md" />
                      : <span className="text-text-dim">removed</span>}
                    <ExpectedBadge expected={expected} />
                  </th>
                  {combos.map((c) => <Cell key={c.key} result={cellByKey.get(`${imageId}|${c.key}`)} expected={run.expectedByImage?.[imageId]} />)}
                </tr>
              );
            })}
            {summary && (
              <>
                {aggRow('Accuracy', (a) => (a?.labeled ? `${a.labeled.correct}/${a.labeled.n} (${Math.round(a.labeled.accuracy * 100)}%)` : '—'))}
                {aggRow('Avg latency', (a) => (a?.meanLatencyMs != null ? `${(a.meanLatencyMs / 1000).toFixed(1)}s` : '—'))}
                {aggRow('Tokens / cost', (a) => (a ? `${a.totalTokens} · $${a.estCost.toFixed(4)}${a.errorCount ? ` · ${a.errorCount} err` : ''}` : '—'))}
              </>
            )}
          </tbody>
        </table>
      </div>
      {summary && (
        <p className="text-sm text-text-dim">
          Total: {summary.totals.totalTokens} tokens · ~${summary.totals.estCost.toFixed(4)}
          {summary.totals.errorCount ? ` · ${summary.totals.errorCount} errors` : ''}
        </p>
      )}
      <div><Button variant="outline" onClick={onExport}>Export JSON</Button></div>
    </Card>
  );
}
