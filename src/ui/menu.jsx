import * as Menu from '@radix-ui/react-dropdown-menu';
import { cn } from './cn.js';

export const MenuRoot = Menu.Root;
export const MenuTrigger = Menu.Trigger;

export function MenuContent({ className, ...props }) {
  return (
    <Menu.Portal>
      <div data-ui="">
        <Menu.Content
          align="end"
          sideOffset={6}
          className={cn('z-50 min-w-44 rounded-md border border-border bg-bg-1 p-1', className)}
          {...props}
        />
      </div>
    </Menu.Portal>
  );
}

export function MenuItem({ className, ...props }) {
  return (
    <Menu.Item
      className={cn('flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-sm outline-none data-[highlighted]:bg-bg-2', className)}
      {...props}
    />
  );
}
