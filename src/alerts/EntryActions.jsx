import { Button } from '../ui/button.jsx';
import { Chip } from '../ui/chip.jsx';

// The two things a reviewer does with a history entry. "Mark" saves a training
// example straight away (a false positive for an alert, a miss for a recent
// frame); "Send to Lab" opens the Examples form pre-filled instead, to edit
// before saving.
export default function EntryActions({ entry, isAlert, marked, onMark, onSendToLab }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {marked ? (
        <Chip tone="ok">Saved as example</Chip>
      ) : (
        <Button
          variant="outline"
          onClick={(e) => { e.stopPropagation(); onMark(entry, isAlert ? 'false-positive' : 'false-negative'); }}
        >
          {isAlert ? 'False positive' : 'Missed — should alert'}
        </Button>
      )}
      <Button variant="ghost" onClick={(e) => { e.stopPropagation(); onSendToLab(entry, { isAlert }); }}>
        Send to Lab
      </Button>
    </div>
  );
}
