import { cn } from './cn.js';

// The one way a labelled control is rendered: label, control, hint, error.
export function Field({ label, htmlFor, hint, error, className, children }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-sm font-semibold">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-text-dim">{hint}</p>}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}

export function Textarea({ className, ...props }) {
  return (
    <textarea
      rows={2}
      className={cn('w-full resize-y rounded-md border border-border bg-bg-0 p-3 text-base placeholder:text-text-dim', className)}
      {...props}
    />
  );
}
