import { Play, Square } from 'lucide-react';
import { Button } from '../ui/button.jsx';

// The primary action. Always on screen: it sits outside the panel's scroll
// area, in the thumb zone on a phone.
export default function ArmBar({ running, onToggle }) {
  return (
    <div className="shrink-0 border-t border-border bg-bg-0 p-3">
      <Button
        id="toggle"
        size="lg"
        variant={running ? 'danger' : 'primary'}
        className="w-full"
        onClick={onToggle}
        aria-pressed={running}
      >
        {running ? <Square className="size-5" aria-hidden /> : <Play className="size-5" aria-hidden />}
        {running ? 'Disarm monitoring' : 'Arm monitoring'}
      </Button>
    </div>
  );
}
