import { isEngineConfigured } from '../../lib/providers.js';
import { cn } from '../ui/cn.js';
import { Card } from '../ui/card.jsx';
import BrowserFields from './BrowserFields.jsx';
import DecisionFields from './DecisionFields.jsx';
import FrameTest from './FrameTest.jsx';
import ProviderFields from './ProviderFields.jsx';

// Each card says what the engine costs and where the frame goes — the actual
// decision the operator is making.
const ENGINES = [
  {
    id: 'provider',
    title: 'Provider',
    where: 'Cloud or local server',
    blurb: 'An OpenAI-compatible vision model (Cerebras, OpenAI, Groq, Ollama…). The frame goes to that server; you pay per token, or nothing for a local one.',
  },
  {
    id: 'browser',
    title: 'In-browser',
    where: 'This device',
    blurb: 'A small vision model on WebGPU. No key, no server, and the frame never leaves the browser. Free; needs a one-time download.',
  },
  {
    id: 'decision',
    title: 'Decision',
    where: 'Classifier via relay',
    blurb: 'A yes/no classifier with a real probability. Faster and cheaper than a chat model; the frame passes through a CORS relay to Replicate, or to your own server.',
  },
];

function Step({ n, title, children }) {
  return (
    <section className="flex flex-col gap-3" aria-label={`Step ${n}: ${title}`}>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <span className="grid size-6 place-items-center rounded-full bg-bg-2 text-xs">{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

// The engine wizard: choose, connect, prove.
export default function EngineCard({ s, set, captureFrame }) {
  const engine = s.engine === 'browser' || s.engine === 'decision' ? s.engine : 'provider';
  const ready = isEngineConfigured(s);
  return (
    <Card className="flex flex-col gap-6" data-setup-card="engine">
      <h2 className="text-xl font-semibold">Engine</h2>

      <Step n={1} title="Choose an engine">
        <div role="radiogroup" aria-label="Inference engine" className="grid gap-2 md:grid-cols-3">
          {ENGINES.map((e) => (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={engine === e.id}
              onClick={() => set.engine(e.id)}
              className={cn(
                'flex min-h-11 flex-col gap-1 rounded-md border p-3 text-left',
                engine === e.id ? 'border-accent bg-accent/10' : 'border-border bg-bg-0 hover:bg-bg-2',
              )}
            >
              <span className="font-semibold">{e.title}</span>
              <span className="text-xs font-semibold text-accent">{e.where}</span>
              <span className="text-xs text-text-dim">{e.blurb}</span>
            </button>
          ))}
        </div>
      </Step>

      <Step n={2} title={engine === 'browser' ? 'Get the model' : 'Connect'}>
        {engine === 'provider' && <ProviderFields s={s} set={set} />}
        {engine === 'browser' && <BrowserFields s={s} set={set} />}
        {engine === 'decision' && (
          <>
            <DecisionFields s={s} set={set} />
            <h4 className="text-sm font-semibold">Announcer / fallback provider (optional)</h4>
            <ProviderFields s={s} set={set} />
          </>
        )}
      </Step>

      <Step n={3} title="Test on the current frame">
        <FrameTest s={s} captureFrame={captureFrame} ready={ready} />
      </Step>

      <p
        className={cn('rounded-md px-3 py-2 text-sm', ready ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn')}
        role="status"
        data-engine-ready={ready}
      >
        {ready ? `Configured — ${ENGINES.find((e) => e.id === engine).title} engine. Run step 3 to confirm it answers.` : 'Not configured — finish step 2 above.'}
      </p>
    </Card>
  );
}
