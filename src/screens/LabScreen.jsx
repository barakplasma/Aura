import { cn } from '../ui/cn.js';

// Tune and Evaluate under one destination (docs/PRD-ux-redesign.md, "Lab").
// Phase 1 only re-homes them: both are still the Ionic screens, passed in.
const TABS = [
  { id: 'tune', label: 'Examples' },
  { id: 'eval', label: 'Evaluate' },
];

export default function LabScreen({ tab, setTab, children }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-2 border-b border-border bg-bg-1 p-2" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'min-h-11 flex-1 rounded-md text-sm font-semibold',
              tab === t.id ? 'bg-accent text-text' : 'bg-bg-2 text-text-dim',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
