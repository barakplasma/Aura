import { cn } from './cn.js';

const CONTROL =
  'w-full min-h-11 rounded-md border border-border bg-bg-0 px-3 text-base placeholder:text-text-dim disabled:opacity-50';

export function Input({ className, ...props }) {
  return <input className={cn(CONTROL, className)} {...props} />;
}

// Native <select>: the OS picker is the right control on a phone.
export function Select({ className, children, ...props }) {
  return (
    <select className={cn(CONTROL, className)} {...props}>
      {children}
    </select>
  );
}

// A number box that doesn't stretch across the row.
export function NumberInput({ className, ...props }) {
  return <Input type="number" inputMode="decimal" className={cn('w-32', className)} {...props} />;
}
