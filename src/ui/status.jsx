import { cn } from './cn.js';

// Inline feedback next to the control that caused it (replaces the old
// screen-wide status line). `tone` is state only: ok / warn / danger.
const TONE = { neutral: 'text-text-dim', ok: 'text-ok', warn: 'text-warn', danger: 'text-danger' };

export function Status({ tone = 'neutral', className, children, ...props }) {
  if (!children) return null;
  return (
    <p role={tone === 'danger' ? 'alert' : 'status'} className={cn('text-xs break-words', TONE[tone], className)} {...props}>
      {children}
    </p>
  );
}
