import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from './cn.js';

export function Switch({ className, ...props }) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'relative h-7 w-12 shrink-0 rounded-full bg-bg-2 border border-border transition-colors data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 translate-x-1 rounded-full bg-text transition-transform data-[state=checked]:translate-x-6" />
    </SwitchPrimitive.Root>
  );
}
