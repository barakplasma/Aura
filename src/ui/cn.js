import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// The shadcn helper: join class names, letting later Tailwind utilities win.
export const cn = (...inputs) => twMerge(clsx(inputs));
