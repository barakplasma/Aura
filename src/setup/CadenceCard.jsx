import { Card } from '../ui/card.jsx';
import { Field } from '../ui/field.jsx';
import { Input, NumberInput, Select } from '../ui/input.jsx';
import { Segmented } from '../ui/segmented.jsx';

const SCAN_MODES = [
  { id: 'interval', label: 'Interval' },
  { id: 'max', label: 'Max' },
  { id: 'budget', label: 'Budget' },
];

const SCAN_EVERY_UNITS = [
  { id: 's', label: 'sec' },
  { id: 'm', label: 'min' },
  { id: 'h', label: 'hr' },
];

const MODE_HINT = {
  interval: 'Fixed gap between scans — predictable cadence.',
  max: 'Freshest image, max frame rate — for free local models (Ollama, LM Studio).',
  budget: 'Cadence derived from your spend / data caps — for cloud within a budget.',
};

// How often to scan, and the caps that govern it. Model pricing lives under
// Advanced; the budget cap needs it.
export default function CadenceCard({ s, set }) {
  return (
    <Card className="flex flex-col gap-4" data-setup-card="cadence">
      <h2 className="text-xl font-semibold">Cadence &amp; cost</h2>
      <Field label="Mode" hint={MODE_HINT[s.scanMode] || MODE_HINT.interval}>
        <Segmented label="Scan timing mode" value={s.scanMode} onChange={set.scanMode} options={SCAN_MODES} />
      </Field>

      {s.scanMode === 'interval' && (
        <Field label="Scan every" htmlFor="scan-every-value" hint="Slower = fewer inferences = lower cost. Anywhere from 1 second to many hours.">
          <div className="flex gap-2">
            <NumberInput id="scan-every-value" min="1" step="any" value={s.scanEveryValue} onChange={(e) => set.scanEveryValue(e.target.value)} />
            <Select id="scan-every-unit" aria-label="Unit" className="w-28" value={s.scanEveryUnit} onChange={(e) => set.scanEveryUnit(e.target.value)}>
              {SCAN_EVERY_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </Select>
          </div>
        </Field>
      )}

      {s.scanMode === 'max' && (
        <p className="text-xs text-text-dim">
          No forced timeout — each scan runs to completion and the next one starts immediately after, for the highest frame rate the model can sustain.
        </p>
      )}

      {s.scanMode === 'budget' && (
        <>
          <Field label="Max $/hour" htmlFor="budget-per-hour" hint="Spend cap — needs the model pricing under Advanced and a provider that reports token usage.">
            <NumberInput id="budget-per-hour" min="0" step="0.01" value={s.budgetPerHour} onChange={(e) => set.budgetPerHour(e.target.value)} />
          </Field>
          <Field label="Max MB/hour" htmlFor="network-mb-per-hour" hint="Upload cap for mobile data — blank = off. The most restrictive cap wins.">
            <Input className="w-32" type="number" id="network-mb-per-hour" min="0" step="1" value={s.networkMbPerHour} onChange={(e) => set.networkMbPerHour(e.target.value)} placeholder="off" />
          </Field>
        </>
      )}

      {s.scanMode !== 'max' && (
        <p className="text-xs text-text-dim">
          The per-request timeout is automatic: the mean plus 3 standard deviations of this session&apos;s own successful response times.
        </p>
      )}
    </Card>
  );
}
