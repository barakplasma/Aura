import { ChevronDown } from 'lucide-react';
import { cn } from '../ui/cn.js';
import { Chip } from '../ui/chip.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.jsx';
import EntryActions from './EntryActions.jsx';

// One point on the timeline. An alert (red) or a recent frame that didn't
// alert (grey). The row selects it; the actions and the reason fold don't.
export default function EntryRow({ entry, isAlert, selected, marked, onSelect, onMark, onSendToLab }) {
  const headline = isAlert ? entry.message : entry.reason || 'No alert.';
  const why = isAlert && entry.reason && entry.reason !== entry.message ? entry.reason : null;
  return (
    <li
      id={`entry-${entry.id}`}
      data-entry={isAlert ? 'alert' : 'missed'}
      className="relative border-l border-border pb-4 pl-5 last:pb-0"
    >
      <span
        className={cn('absolute top-2 -left-1.5 size-3 rounded-full', isAlert ? 'bg-danger' : 'bg-text-dim')}
        aria-hidden
      />
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect(entry)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(entry); } }}
        className={cn(
          'flex cursor-pointer gap-3 rounded-lg border p-3',
          selected ? 'border-accent bg-accent/10' : 'border-border bg-bg-1 hover:bg-bg-2',
        )}
      >
        {entry.image ? (
          <img className="aspect-4/3 w-24 shrink-0 rounded-md object-cover md:w-32" src={entry.image} alt={isAlert ? 'Frame that triggered this alert' : 'Recent frame with no alert'} />
        ) : (
          <div className="grid aspect-4/3 w-24 shrink-0 place-items-center rounded-md bg-bg-0 text-xs text-text-dim md:w-32">No frame</div>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-dim">{entry.time}</span>
            {entry.conf != null && <Chip tone={isAlert ? 'warn' : 'neutral'}>{entry.conf}%</Chip>}
          </div>
          <p className={cn('text-sm font-semibold break-words', !isAlert && 'text-text-dim')}>{headline}</p>
          {why && (
            <Collapsible onClick={(e) => e.stopPropagation()}>
              <CollapsibleTrigger className="flex min-h-11 items-center gap-1 text-xs text-text-dim">
                <ChevronDown className="size-4" aria-hidden />Why
              </CollapsibleTrigger>
              <CollapsibleContent className="text-sm break-words select-text">{why}</CollapsibleContent>
            </Collapsible>
          )}
          <EntryActions entry={entry} isAlert={isAlert} marked={marked} onMark={onMark} onSendToLab={onSendToLab} />
        </div>
      </div>
    </li>
  );
}
