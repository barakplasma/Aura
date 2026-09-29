import { cva } from 'class-variance-authority';
import { cn } from './cn.js';

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-text hover:brightness-110',
        danger: 'bg-danger text-bg-0 hover:brightness-110',
        outline: 'border border-border bg-bg-2 hover:bg-bg-1',
        ghost: 'hover:bg-bg-2',
      },
      size: {
        md: 'min-h-11 px-4 text-sm',
        lg: 'min-h-14 px-6 text-base',
        icon: 'size-11',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export function Button({ className, variant, size, ...props }) {
  return <button type="button" className={cn(button({ variant, size }), className)} {...props} />;
}
