import { useState } from 'react';
import { groupEvalModels } from '../../lib/eval.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Input } from '../ui/input.jsx';
import { Switch } from '../ui/switch.jsx';
import { evalModelLabel } from './model-label.js';

// The models a run compares, grouped by the engine that runs them: one matrix
// can put a cloud model, a local one, an in-browser one and a classifier side
// by side.
export default function ModelPicker({ models, selected, onToggle, onAddManual, onFetch, fetching }) {
  const [manual, setManual] = useState('');
  function add() {
    if (!manual.trim()) return;
    onAddManual(manual.trim());
    setManual('');
  }
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">Models ({selected.length} selected)</h2>
      <div><Button variant="outline" disabled={fetching} onClick={onFetch}>{fetching ? 'Fetching…' : 'Fetch models'}</Button></div>
      {groupEvalModels(models).map((g) => (
        <fieldset key={g.engine} className="flex flex-col" aria-label={g.label}>
          <legend className="px-1 pb-1 text-sm font-semibold text-text-dim">{g.label}</legend>
          {g.ids.map((m) => {
            const { name, sub } = evalModelLabel(m);
            return (
              <div key={m} className="flex min-h-11 items-center justify-between gap-3 border-t border-border first:border-t-0">
                <label htmlFor={`eval-model-${m}`} className="flex-1 text-sm break-words">
                  {name}
                  {sub && <span className="text-xs text-text-dim"> — {sub}</span>}
                </label>
                <Switch id={`eval-model-${m}`} checked={selected.includes(m)} onCheckedChange={() => onToggle(m)} />
              </div>
            );
          })}
        </fieldset>
      ))}
      <div className="flex gap-2">
        <Input
          value={manual}
          aria-label="Add model name manually"
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Add model name manually"
        />
        <Button variant="outline" onClick={add}>Add</Button>
      </div>
    </Card>
  );
}
