import { cn } from './cn.js';

// A radio group drawn as joined buttons. `options` are { id, label, hint? }.
export function Segmented({ value, onChange, options, label, className }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('flex gap-2', className)}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            'min-h-11 flex-1 rounded-md px-3 text-sm font-semibold',
            value === o.id ? 'bg-accent text-text' : 'bg-bg-2 text-text-dim hover:text-text',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
