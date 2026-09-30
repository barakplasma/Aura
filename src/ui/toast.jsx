import { cn } from './cn.js';

// A banner pinned to the top, so it never covers the arm bar. `actions` are
// { text, onClick } buttons. Replaces Ionic's IonToast.
export function Toast({ open, tone = 'neutral', message, actions = [] }) {
  if (!open) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-50 flex justify-center px-3">
      <div
        role="status"
        className={cn(
          'pointer-events-auto flex w-full max-w-xl items-center gap-2 rounded-md border border-border py-1 pr-1 pl-4 text-sm',
          tone === 'warn' ? 'bg-warn text-bg-0' : 'bg-bg-2 text-text',
        )}
      >
        <span className="flex-1">{message}</span>
        {actions.map((a) => (
          <button
            key={a.text}
            type="button"
            className="min-h-11 rounded-md px-3 font-semibold uppercase"
            onClick={a.onClick}
          >
            {a.text}
          </button>
        ))}
      </div>
    </div>
  );
}
