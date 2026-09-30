import { useState } from 'react';
import { scanClient } from '../../lib/aura.js';
import { scanBrowser } from '../../lib/browser-engine.js';
import { scanDecision } from '../../lib/decision.js';
import { runFrameTest } from '../../lib/frame-test.js';
import { reportHandledError } from '../monitoring.js';
import ProgressBar from '../components/ProgressBar.jsx';
import { Button } from '../ui/button.jsx';
import { Status } from '../ui/status.jsx';

const SCANS = { provider: scanClient, browser: scanBrowser, decision: scanDecision };
const AREA = { provider: 'provider-test', browser: 'browser-model-test', decision: 'decision-test' };
const INFERENCE = { provider: 'cloud-provider', browser: 'in-browser', decision: 'decision-endpoint' };

// Step 3, for every engine: one detection pass on the frame the stage is
// showing, so "configured" is proven rather than inferred.
export default function FrameTest({ s, captureFrame, ready }) {
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(null);
  const [out, setOut] = useState(null);

  async function handleTest() {
    setRunning(true);
    setOut(null);
    setPct(null);
    try {
      const r = await runFrameTest({
        settings: s,
        frame: captureFrame?.() ?? null,
        scans: SCANS,
        onProgress: (m) => { if (m.pct != null) setPct(m.pct); },
      });
      setOut(r);
    } catch (err) {
      const engine = s.engine === 'browser' || s.engine === 'decision' ? s.engine : 'provider';
      reportHandledError(err, { area: AREA[engine], inference: INFERENCE[engine], phase: 'inference', ...(err.browserContext || {}) });
      setOut({ error: err.message });
    } finally {
      setRunning(false);
      setPct(null);
    }
  }

  const v = out?.verdict;
  const raw = out?.result?.rawText;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button id="frame-test-btn" variant="outline" disabled={running || !ready} onClick={handleTest}>
          {running ? 'Testing…' : 'Test on current frame'}
        </Button>
        {!ready && <span className="text-xs text-text-dim">Finish step 2 first.</span>}
      </div>
      {running && pct != null && <ProgressBar phase="processing" pct={pct} label="Loading model" />}
      {out?.error && <Status tone="danger" id="frame-test-result">Test failed: {out.error}</Status>}
      {v && (
        <div id="frame-test-result" className="flex flex-col gap-1 rounded-md bg-bg-0 p-3 text-sm" role="status">
          <p className="font-semibold">
            {out.result.triggered ? 'Would alert' : 'Clear'} · {Math.round(v.confidence ?? 0)}%
            {v.latencyMs != null && <span className="font-normal text-text-dim"> · {v.latencyMs} ms{out.result.timing?.predict ? ` (model ${out.result.timing.predict} ms)` : ''}</span>}
          </p>
          <p className="break-words select-text">&ldquo;{v.reason}&rdquo;</p>
          {/* The unprocessed model output. "Nothing notable in view." is also
              parseLooseDetection()'s fallback, so without this the model
              saw-nothing and parser-choke cases look identical. */}
          {raw && raw !== v.reason && (
            <p className="text-xs break-words text-text-dim select-text">Model said: {String(raw).slice(0, 400)}</p>
          )}
          {v.note && <Status tone="warn">{v.note.text}: {v.note.detail}</Status>}
        </div>
      )}
    </div>
  );
}
