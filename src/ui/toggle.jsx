import { cn } from './cn.js';
import { Switch } from './switch.jsx';

// A labelled on/off row with an optional hint underneath.
export function Toggle({ id, label, hint, checked, onChange, disabled, className }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={id} className="text-sm font-semibold">{label}</label>
        <Switch id={id} checked={Boolean(checked)} onCheckedChange={onChange} disabled={disabled} />
      </div>
      {hint && <p className="text-xs text-text-dim">{hint}</p>}
    </div>
  );
}
