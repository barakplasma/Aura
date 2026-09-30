import { useState, useCallback, useEffect } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { getExamples, addExample, removeExample, clearExamples } from '../../lib/training-store.js';
import { Button } from '../ui/button.jsx';
import { Card } from '../ui/card.jsx';
import { Chip } from '../ui/chip.jsx';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible.jsx';
import { Field, Textarea } from '../ui/field.jsx';
import { Input, NumberInput, Select } from '../ui/input.jsx';
import { SecretInput } from '../ui/secret-input.jsx';
import { Status } from '../ui/status.jsx';
import { Toggle } from '../ui/toggle.jsx';

// Lab › Examples: the few-shot examples the detector and announcer are shown,
// and the GEPA run that tunes their prompts. `prefill` is a history entry sent
// over from Alerts: it fills the detection form and shows its frame beside it.
export default function OptimizeScreen({ prefill, onPrefillUsed, mission }) {
  const [trainType, setTrainType] = useState('detection');
  const [examples, setExamples] = useState(() => getExamples());
  const [status, setStatus] = useState(null); // { tone, text }
  const [fieldError, setFieldError] = useState(null); // { field, text }
  const [optimizing, setOptimizing] = useState(false);
  const [trainApikey, setTrainApikey] = useState('');
  const [frame, setFrame] = useState(null); // the frame a prefill came with, for reference

  // Detection form
  const [trainMission, setTrainMission] = useState('');
  const [trainScene, setTrainScene] = useState('');
  const [trainTriggered, setTrainTriggered] = useState(false);
  const [trainConfidence, setTrainConfidence] = useState(80);
  const [trainReason, setTrainReason] = useState('');

  // Action form
  const [trainInstruction, setTrainInstruction] = useState('');
  const [trainContext, setTrainContext] = useState('');
  const [trainMessage, setTrainMessage] = useState('');

  const refresh = useCallback(() => setExamples(getExamples()), []);

  // Fill the detection form from an alert or recent frame (Send to Lab).
  useEffect(() => {
    if (!prefill) return;
    setTrainType('detection');
    setTrainMission(prefill.mission || mission || '');
    setTrainScene(prefill.sceneDescription);
    setTrainTriggered(prefill.triggered);
    setTrainConfidence(prefill.confidence);
    setTrainReason(prefill.reason);
    setFrame(prefill.image);
    setFieldError(null);
    setStatus({ tone: 'neutral', text: 'Filled from an alert. Set what the model should have answered, then add it.' });
    onPrefillUsed?.();
  }, [prefill, mission, onPrefillUsed]);

  function flash(text) {
    setStatus({ tone: 'ok', text });
    setTimeout(() => setStatus((s) => (s?.text === text ? null : s)), 2000);
  }

  function handleAdd() {
    let ex;
    if (trainType === 'detection') {
      if (!trainMission.trim()) { setFieldError({ field: 'mission', text: 'Mission is required.' }); return; }
      ex = { type: 'detection', mission: trainMission.trim(), sceneDescription: trainScene.trim(), triggered: trainTriggered, confidence: trainConfidence, reason: trainReason.trim() };
    } else {
      if (!trainInstruction.trim()) { setFieldError({ field: 'instruction', text: 'Instruction is required.' }); return; }
      ex = { type: 'action', instruction: trainInstruction.trim(), context: trainContext.trim(), message: trainMessage.trim() };
    }
    addExample(ex);
    refresh();
    setFieldError(null);
    flash('Example added.');
    if (trainType === 'detection') { setTrainMission(''); setTrainScene(''); setTrainTriggered(false); setTrainConfidence(80); setTrainReason(''); setFrame(null); }
    else { setTrainInstruction(''); setTrainContext(''); setTrainMessage(''); }
  }

  function handleClear() {
    clearExamples();
    refresh();
    setStatus({ tone: 'neutral', text: 'All examples cleared.' });
  }

  async function runOpt(type) {
    if (!trainApikey.trim()) { setStatus({ tone: 'danger', text: 'Enter a Cerebras API key for optimization.' }); return; }
    const exList = getExamples().filter((ex) => ex.type === type);
    if (exList.length < 2) { setStatus({ tone: 'danger', text: `Need at least 2 ${type} examples.` }); return; }
    setOptimizing(true);
    setStatus({ tone: 'neutral', text: `Optimizing ${type}… this may take a minute.` });
    try {
      // Dynamic import keeps the heavy @ax-llm/ax optimizer out of the bundle
      // until an optimization actually runs.
      const { runDetectionOptimization, runActionOptimization } = await import('../../lib/training.js');
      const fn = type === 'detection' ? runDetectionOptimization : runActionOptimization;
      const result = await fn({ apiKey: trainApikey.trim(), examples: exList });
      setStatus({ tone: 'ok', text: `${type} optimization done! Best score: ${result.bestScore?.toFixed(2) || '?'}` });
    } catch (err) {
      setStatus({ tone: 'danger', text: `Optimization failed: ${err.message}` });
    } finally {
      setOptimizing(false);
    }
  }

  const err = (field) => (fieldError?.field === field ? fieldError.text : undefined);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg-0 p-3">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        <h1 className="px-1 text-3xl font-semibold">Examples</h1>
        <Card className="flex flex-col gap-4">
          <Field label="Example type" htmlFor="train-type">
            <Select id="train-type" value={trainType} onChange={(e) => setTrainType(e.target.value)}>
              <option value="detection">Detection</option>
              <option value="action">Action</option>
            </Select>
          </Field>

          {trainType === 'detection' ? (
            <div id="train-detection-fields" className="flex flex-col gap-4">
              {frame && (
                <img className="aspect-4/3 w-full max-w-sm rounded-md bg-bg-0 object-contain" src={frame} alt="The frame this example is about" />
              )}
              <Field label="Mission prompt" htmlFor="train-mission" error={err('mission')}>
                <Input id="train-mission" value={trainMission} onChange={(e) => setTrainMission(e.target.value)} placeholder="What to watch for" />
              </Field>
              <Field label="Scene description" htmlFor="train-scene">
                <Textarea id="train-scene" value={trainScene} onChange={(e) => setTrainScene(e.target.value)} placeholder="What the camera sees" />
              </Field>
              <Toggle id="train-triggered" label="Should trigger" checked={trainTriggered} onChange={setTrainTriggered} />
              <Field label="Confidence" htmlFor="train-confidence">
                <NumberInput id="train-confidence" min="0" max="100" value={trainConfidence} onChange={(e) => setTrainConfidence(Number(e.target.value))} />
              </Field>
              <Field label="Expected reason" htmlFor="train-reason">
                <Input id="train-reason" value={trainReason} onChange={(e) => setTrainReason(e.target.value)} placeholder="Why it triggered" />
              </Field>
            </div>
          ) : (
            <div id="train-action-fields" className="flex flex-col gap-4">
              <Field label="Action instruction" htmlFor="train-instruction" error={err('instruction')}>
                <Input id="train-instruction" value={trainInstruction} onChange={(e) => setTrainInstruction(e.target.value)} placeholder="What to say or do" />
              </Field>
              <Field label="Detection context" htmlFor="train-context">
                <Input id="train-context" value={trainContext} onChange={(e) => setTrainContext(e.target.value)} placeholder="What was detected" />
              </Field>
              <Field label="Expected message" htmlFor="train-message">
                <Textarea id="train-message" value={trainMessage} onChange={(e) => setTrainMessage(e.target.value)} placeholder="What should be announced" />
              </Field>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button id="train-add-btn" onClick={handleAdd}>Add example</Button>
            <Button id="train-clear-btn" variant="outline" onClick={handleClear}>Clear all</Button>
          </div>
          <Status id="train-status" tone={status?.tone}>{status?.text}</Status>
        </Card>

        <Card className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold">Saved examples <Chip>{examples.length}</Chip></h2>
          {examples.length === 0 && <p className="text-sm text-text-dim">None yet. Mark an alert as a false positive, or add one above.</p>}
          <ul id="train-example-list" className="flex flex-col">
            {examples.map((ex) => (
              <li key={ex.id} className="flex min-h-11 items-center gap-2 border-t border-border first:border-t-0">
                <span className="flex-1 text-sm break-words">
                  {ex.type === 'detection'
                    ? `det: "${(ex.mission || ex.sceneDescription || '').slice(0, 40)}" → ${ex.triggered ? 'T' : 'F'}/${ex.confidence}`
                    : `act: "${(ex.instruction || '').slice(0, 40)}"`}
                </span>
                <Button variant="ghost" size="icon" aria-label="Remove example" onClick={() => { removeExample(ex.id); refresh(); }}>
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <Collapsible>
            <CollapsibleTrigger className="flex min-h-11 w-full items-center gap-2 text-left text-xl font-semibold">
              <span className="flex-1">Optimization</span><ChevronDown className="size-4" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4 pt-2">
              <Field label="Cerebras API key (for training)" htmlFor="train-apikey">
                <SecretInput id="train-apikey" value={trainApikey} onChange={(e) => setTrainApikey(e.target.value)} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button id="train-opt-detection" disabled={optimizing} onClick={() => runOpt('detection')}>Optimize detection</Button>
                <Button id="train-opt-action" disabled={optimizing} onClick={() => runOpt('action')}>Optimize action</Button>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      </div>
    </div>
  );
}
