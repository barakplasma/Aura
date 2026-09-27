import { useState } from 'react';
import {
  DECISION_MODELS,
  RELAY_PRESETS,
  relayPresetFor,
  decisionModelKeys,
  defaultDecisionUrl,
  getDecisionModel,
  usesRelay,
  DEFAULT_DECISION_MODEL,
} from '../../lib/decision-models.js';
import { scanDecision, missionToQuestion } from '../../lib/decision.js';
import { reportHandledError } from '../monitoring.js';

const ANNOUNCERS = [
  { id: 'provider', label: 'PROVIDER' },
  { id: 'browser', label: 'BROWSER' },
  { id: 'template', label: 'TEMPLATE' },
];

// DECISION engine settings (docs/PRD-decision-engine.md): which typed-decision
// model, the relay (or self-hosted server) URL, the user's OWN key, who words
// a fired alert, and whether a failed decision falls back to the provider.
export default function DecisionSettings({
  decisionModel, setDecisionModel,
  decisionUrl, setDecisionUrl,
  decisionKey, setDecisionKey,
  decisionAnnouncer, setDecisionAnnouncer,
  decisionFallback, setDecisionFallback,
  providerConfigured,
  mission,
  captureFrame,
  onStatusMsg,
}) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const rowKey = getDecisionModel(decisionModel) ? decisionModel : DEFAULT_DECISION_MODEL;
  const row = DECISION_MODELS[rowKey];
  const relayed = usesRelay(row);

  // Switching between a hosted row and a self-hosted one changes where the
  // key goes, so the key is dropped — a Replicate token must never reach
  // someone's llama-server, nor its key reach Replicate. Rows on the same
  // upstream keep both the URL and the key.
  function selectRow(key) {
    const next = DECISION_MODELS[key];
    if (next.upstream !== row.upstream) {
      setDecisionUrl(defaultDecisionUrl(next));
      if (decisionKey) {
        setDecisionKey('');
        onStatusMsg?.('Switched decision endpoint — key cleared. Enter the key for the new endpoint.');
      }
    }
    setDecisionModel(key);
  }

  async function handleTest() {
    const frame = captureFrame?.();
    if (!frame) { setTestResult({ error: 'Start monitoring first so there is a camera frame to test.' }); return; }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await scanDecision({
        modelId: rowKey,
        url: decisionUrl,
        apiKey: decisionKey || undefined,
        mission,
        question: missionToQuestion({ mission }),
        image: frame,
        threshold: 0,
        // Cold Replicate workers take minutes; a test is worth waiting for.
        requestTimeout: 300,
      });
      setTestResult(r);
    } catch (err) {
      reportHandledError(err, { area: 'decision-test', inference: 'decision-endpoint', model: rowKey });
      setTestResult({ error: err.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <div className="form-group">
        <label className="field-label" htmlFor="decision-model-select">DECISION MODEL</label>
        <select id="decision-model-select" className="dc-input" value={rowKey} onChange={e => selectRow(e.target.value)}>
          {decisionModelKeys().map((key) => (
            <option key={key} value={key}>{DECISION_MODELS[key].label}</option>
          ))}
        </select>
        <div className="field-hint">
          {row.note}
          {row.benchmark && (
            <> Benchmark: {row.benchmark.summary} (<a href={row.benchmark.source} target="_blank" rel="noreferrer">source</a>, read {row.benchmark.readOn}).</>
          )}
        </div>
      </div>

      <div className="form-group">
        <label className="field-label" htmlFor="decision-url">{relayed ? 'CORS RELAY' : 'SERVER URL'}</label>
        <input
          id="decision-url"
          className="dc-input"
          value={decisionUrl}
          onChange={e => setDecisionUrl(e.target.value)}
          placeholder={relayed ? 'https://relay.example{path}' : 'http://localhost:54100'}
        />
        {relayed ? (
          <>
            <div className="btn-row">
              {RELAY_PRESETS.map((p) => (
                <button key={p.id} className={`dc-btn ${decisionUrl === p.url ? '' : 'outline'}`} onClick={() => setDecisionUrl(p.url)}>
                  {p.label.toUpperCase()}
                </button>
              ))}
            </div>
            {relayPresetFor(decisionUrl) && <div className="field-hint">{relayPresetFor(decisionUrl).note}</div>}
            <div className="field-hint">
              A browser can't call Replicate directly (no CORS), so requests go through a relay that
              only adds CORS headers. <code>{'{path}'}</code>, <code>{'{url}'}</code> and <code>{'{url:encoded}'}</code> are
              filled in per request. <strong>Your token and camera frames pass through the relay</strong> on
              the way to Replicate — use your own relay if you'd rather no one else sees them.
            </div>
          </>
        ) : (
          <div className="field-hint">
            Your own <code>/v1/systemone</code> server, called directly. It must allow this page's origin
            (<code>--cors-origins</code>); frames stay on your infrastructure.
          </div>
        )}
      </div>

      <div className="form-group">
        <label className="field-label" htmlFor="decision-key">{relayed ? 'YOUR REPLICATE TOKEN' : 'SERVER API KEY'}</label>
        <input
          id="decision-key"
          type="password"
          className="dc-input"
          value={decisionKey}
          onChange={e => setDecisionKey(e.target.value)}
          placeholder={relayed ? 'r8_…' : 'blank if the server needs none'}
        />
        <div className="field-hint">
          {relayed
            ? 'Your own token, billed to your own Replicate account for predict time only. Stored in this browser; the relay forwards it and keeps nothing.'
            : 'Leave blank for a server started without --api-key.'}
        </div>
      </div>

      <div className="form-group">
        <label className="field-label">ANNOUNCER</label>
        <div className="mode-segments" role="radiogroup" aria-label="Announcer">
          {ANNOUNCERS.map((a) => (
            <button
              key={a.id}
              className={`mode-segment ${decisionAnnouncer === a.id ? 'active' : ''}`}
              role="radio" aria-checked={decisionAnnouncer === a.id}
              onClick={() => setDecisionAnnouncer(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <div className="field-hint">
          Decision models return probabilities, not words. When an alert fires, the
          {decisionAnnouncer === 'provider' && ' provider below writes the announcement (one chat call, only when fired).'}
          {decisionAnnouncer === 'browser' && ' BROWSER engine model writes it on this device.'}
          {decisionAnnouncer === 'template' && ' mission\'s "on alert, announce" text is spoken as written.'}
          {decisionAnnouncer === 'provider' && !providerConfigured && ' No provider is configured yet, so the template is used.'}
          {' '}If the announcer fails, the template speaks — the alert itself is never dropped.
        </div>
      </div>

      <div className="form-group">
        <label className="toggle-label">
          <input
            id="decision-fallback-toggle"
            type="checkbox"
            className="dc-checkbox"
            checked={Boolean(decisionFallback)}
            onChange={e => setDecisionFallback(e.target.checked)}
          />
          <span>FALL BACK TO PROVIDER</span>
        </label>
        <div className="field-hint">
          A cold start, outage or rejected key re-runs that scan on the provider below
          {providerConfigured ? '' : ' (none configured yet, so this has no effect)'}.
        </div>
      </div>

      {row.calibrated === false && (
        <p className="status-msg">This model returns no probabilities: confidence is 100 or 0 from its answer.</p>
      )}

      <div className="btn-row">
        <button id="decision-test-btn" className="dc-btn outline" disabled={testing} onClick={handleTest}>
          {testing ? 'TESTING…' : 'TEST ON CURRENT FRAME'}
        </button>
      </div>
      {testResult && (
        <p className="status-msg" role="status">
          {testResult.error
            ? `Test failed: ${testResult.error}`
            : `${testResult.triggered ? 'TRIGGERED' : 'clear'} ${testResult.confidence}% — "${testResult.reason}" (${testResult.latencyMs}ms${testResult.timing?.predict ? `, model ${testResult.timing.predict}ms` : ''})`}
        </p>
      )}
    </>
  );
}
