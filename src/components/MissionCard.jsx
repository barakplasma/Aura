import { ChevronDown } from 'lucide-react';
import { missionToQuestion } from '../../lib/decision.js';
import { Card } from '../ui/card.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.jsx';
import { Field, Textarea } from '../ui/field.jsx';
import { Slider } from '../ui/slider.jsx';
import { Switch } from '../ui/switch.jsx';

function ToggleRow({ id, label, checked, onChange }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3">
      <label htmlFor={id}>{label}</label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// What to watch for, how to announce it, and how sure the model has to be.
// While armed it folds to one line so the verdict keeps the room.
export default function MissionCard({
  running, engine, mission, setMission, action, setAction,
  speech, setSpeech, haptics, setHaptics, threshold, setThreshold, onOpenLab,
}) {
  // What the next scan will actually ask — the decision engine's own yes/no
  // template (lib/decision.js missionToQuestion), nothing to keep in sync.
  const question = engine === 'decision' ? missionToQuestion({ mission }).question : null;
  return (
    <Card>
      <Collapsible key={running ? 'armed' : 'idle'} defaultOpen={!running}>
        <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 text-left">
          <span className="flex-1">
            <span className="block text-xs text-text-dim">Watch for</span>
            <span className="block truncate text-sm font-semibold">{mission || 'Describe what to watch for'}</span>
          </span>
          <ChevronDown className="size-4 shrink-0" aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 pt-2">
          <Field label="Watch for" htmlFor="mission-text">
            <Textarea
              id="mission-text"
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              placeholder="Alert if someone is loitering near the front door."
            />
          </Field>
          {question && (
            <p className="text-xs text-text-dim">
              The decision model answers one yes/no question per frame:{' '}
              <strong id="decision-active-question" className="text-text">{question}</strong>
            </p>
          )}
          <Field label="On alert, announce" htmlFor="action-text">
            <Textarea
              id="action-text"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="Tell the person they are being recorded and to leave."
            />
          </Field>
          <Field
            label={`Minimum confidence: ${threshold}%`}
            htmlFor="threshold"
            hint={threshold === 0 ? 'Every detection the model reports can alert.' : `Alerts only fire at ${threshold}% or above.`}
          >
            <Slider id="threshold" min={0} max={100} step={5} value={[threshold]} onValueChange={([v]) => setThreshold(v)} />
          </Field>
          <ToggleRow id="speech-toggle" label="Speak alerts" checked={speech} onChange={setSpeech} />
          <ToggleRow id="haptics-toggle" label="Vibrate" checked={haptics} onChange={setHaptics} />
          {engine !== 'browser' && engine !== 'decision' && (
            <p className="text-xs text-text-dim">
              Improve detection with examples in{' '}
              <button type="button" className="underline" onClick={onOpenLab}>Lab</button>.
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
