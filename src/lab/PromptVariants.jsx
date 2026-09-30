import { X } from 'lucide-react';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Textarea } from '../ui/field.jsx';
import { Input } from '../ui/input.jsx';

export default function PromptVariants({ variants, usableCount, onAdd, onChange, onRemove }) {
  return (
    <Card className="flex flex-col gap-3">
      <h2 className="text-xl font-semibold">Prompt variants ({usableCount})</h2>
      {variants.map((v, idx) => (
        <div key={v.id} className="flex flex-col gap-2 rounded-md border border-border p-3">
          <div className="flex gap-2">
            <Input aria-label="Variant name" value={v.name} onChange={(e) => onChange(v.id, 'name', e.target.value)} placeholder={`Variant ${idx + 1}`} />
            <Button variant="ghost" size="icon" aria-label="Remove variant" onClick={() => onRemove(v.id)}><X className="size-4" aria-hidden /></Button>
          </div>
          <Textarea aria-label="Mission" value={v.mission} onChange={(e) => onChange(v.id, 'mission', e.target.value)} placeholder="Mission — what to watch for" />
          <Textarea aria-label="Extra instruction" rows={1} value={v.instruction} onChange={(e) => onChange(v.id, 'instruction', e.target.value)} placeholder="Optional extra instruction (advanced)" />
        </div>
      ))}
      <div><Button onClick={onAdd}>Add variant</Button></div>
    </Card>
  );
}
