import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from './cn.js';

export function Slider({ className, ...props }) {
  return (
    <SliderPrimitive.Root className={cn('relative flex h-11 w-full touch-none items-center select-none', className)} {...props}>
      <SliderPrimitive.Track className="relative h-2 grow rounded-full bg-bg-2">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb className="block size-6 rounded-full bg-text shadow-none border-2 border-accent" />
    </SliderPrimitive.Root>
  );
}
