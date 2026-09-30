import * as Dialog from '@radix-ui/react-dialog';
import { cn } from './cn.js';

// Bottom sheet below 700 px, centred dialog above.
export function Sheet({ open, onOpenChange, title, description, children }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bg-0/70" />
          <Dialog.Content
            className={cn(
              'fixed z-50 flex max-h-[85dvh] flex-col gap-3 overflow-auto border border-border bg-bg-1 p-4',
              'inset-x-0 bottom-0 rounded-t-lg',
              'md:inset-auto md:top-1/2 md:left-1/2 md:w-[32rem] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg',
            )}
          >
            <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
            <Dialog.Description className={description ? 'text-text-dim' : 'sr-only'}>
              {description || title}
            </Dialog.Description>
            {children}
          </Dialog.Content>
        </>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
