import { cva } from 'class-variance-authority';
import { cn } from './cn.js';

const chip = cva('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold', {
  variants: {
    tone: {
      neutral: 'bg-bg-2 text-text-dim',
      ok: 'bg-ok/15 text-ok',
      warn: 'bg-warn/15 text-warn',
      danger: 'bg-danger/15 text-danger',
      info: 'bg-info/15 text-info',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Chip({ className, tone, ...props }) {
  return <span className={cn(chip({ tone }), className)} {...props} />;
}
