import { cn } from './cn.js';

export function Card({ className, ...props }) {
  return <div className={cn('rounded-lg border border-border bg-bg-1 p-4', className)} {...props} />;
}
