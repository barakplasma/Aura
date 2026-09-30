import { Card } from '../ui/card.jsx';
import { Chip } from '../ui/chip.jsx';
import EntryActions from './EntryActions.jsx';

// The selected entry, large: the frame at full width, what was said about it,
// and the same review actions as its row. Beside the list on desktop, in a
// sheet on a phone.
export default function FramePreview({ entry, isAlert, marked, onMark, onSendToLab }) {
  if (!entry) {
    return <Card className="text-sm text-text-dim">Select an entry to see its frame.</Card>;
  }
  return (
    <Card className="flex flex-col gap-3">
      {entry.image ? (
        <img className="aspect-4/3 w-full rounded-md bg-bg-0 object-contain" src={entry.image} alt="Selected frame" />
      ) : (
        <div className="grid aspect-4/3 w-full place-items-center rounded-md bg-bg-0 text-sm text-text-dim">No frame was kept for this entry</div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={isAlert ? 'danger' : 'neutral'}>{isAlert ? 'Alert' : 'No alert'}</Chip>
        <span className="text-xs text-text-dim">{entry.time}</span>
        {entry.conf != null && <Chip tone="warn">{entry.conf}%</Chip>}
      </div>
      <p className="text-base font-semibold break-words select-text">{isAlert ? entry.message : entry.reason || 'No alert.'}</p>
      {isAlert && entry.reason && entry.reason !== entry.message && (
        <p className="text-sm break-words text-text-dim select-text">{entry.reason}</p>
      )}
      <EntryActions entry={entry} isAlert={isAlert} marked={marked} onMark={onMark} onSendToLab={onSendToLab} />
    </Card>
  );
}
