import { useState } from 'react';
import { fetchModels } from '../../lib/aura.js';
import { testVibration, canVibrate } from '../../public/feedback.js';

export default function SettingsScreen({
  baseUrl, setBaseUrl,
  apiKey, setApiKey,
  model, setModel,
  scanEvery, setScanEvery,
  rate, setRate,
  webhookUrl, setWebhookUrl,
  webhookMethod, setWebhookMethod,
  webhookHeaders, setWebhookHeaders,
  webhookAction, setWebhookAction,
  webhookSchema, setWebhookSchema,
  onStatusMsg,
}) {
  const [models, setModels] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [vibeStatus, setVibeStatus] = useState('');
  const [webhookStatus, setWebhookStatus] = useState('');

  async function handleFetchModels() {
    if (!baseUrl) { onStatusMsg('Enter a Base URL first.'); return; }
    if (!apiKey) { onStatusMsg('Enter an API key first.'); return; }
    setFetchingModels(true);
    try {
      const list = await fetchModels(baseUrl, apiKey);
      setModels(list);
      setShowDropdown(list.length > 0);
      if (list.length > 0 && !model) setModel(list[0]);
      onStatusMsg(`Found ${list.length} models.`);
    } catch (err) {
      onStatusMsg(`Fetch failed: ${err.message}. You can type a model name manually.`);
    } finally {
      setFetchingModels(false);
    }
  }

  function selectModel(m) {
    setModel(m);
    setShowDropdown(false);
  }

  const filteredModels = models.filter(m => m.toLowerCase().includes((model || '').toLowerCase()));

  function handleVibeTest() {
    testVibration();
    setVibeStatus('Buzzing now — feel that?');
  }

  async function handleWebhookTest() {
    setWebhookStatus('Sending test…');
    const body = JSON.stringify({ event: 'test', timestamp: new Date().toISOString(), message: 'Aura webhook test.' });
    const url = (webhookUrl || '').trim();
    if (!url) { setWebhookStatus('No URL configured.'); return; }
    let headers = { 'Content-Type': 'application/json' };
    try {
      const custom = JSON.parse((webhookHeaders || '').trim() || '{}');
      if (custom && typeof custom === 'object') headers = { ...headers, ...custom };
    } catch {}
    fetch(url, { method: webhookMethod || 'POST', headers, body, signal: AbortSignal.timeout(5000), mode: 'no-cors' }).catch(() => {});
    setWebhookStatus('Test sent.');
    setTimeout(() => setWebhookStatus(s => s === 'Test sent.' ? '' : s), 3000);
  }

  return (
    <div className="screen screen-settings">
      <div className="screen-header">
        <span className="screen-title">SYSTEM SETTINGS</span>
      </div>

      <div className="settings-section">
        <div className="section-label">PROVIDER</div>
        <div className="form-group">
          <label className="field-label">BASE URL</label>
          <input id="provider-baseurl" type="url" className="dc-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.cerebras.ai/v1" />
        </div>
        <div className="form-group">
          <label className="field-label">API KEY</label>
          <input id="provider-apikey" type="password" className="dc-input" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="csk-xxxx or sk-xxxx" />
        </div>
        <div className="form-group model-row">
          <div style={{ flex: 1 }}>
            <label className="field-label">MODEL</label>
            <input
              id="provider-model"
              className="dc-input"
              value={model}
              onChange={e => { setModel(e.target.value); setShowDropdown(models.length > 0); }}
              onBlur={() => setTimeout(() => setShowDropdown(false), 150)}
              placeholder="gemma-4-31b"
            />
            {showDropdown && filteredModels.length > 0 && (
              <div id="model-dropdown" className="model-dropdown">
                {filteredModels.map(m => (
                  <div key={m} className="model-dropdown-item" role="option" onMouseDown={() => selectModel(m)}>{m}</div>
                ))}
              </div>
            )}
          </div>
          <button id="fetch-models-btn" className="dc-btn" disabled={fetchingModels} onClick={handleFetchModels}>
            {fetchingModels ? 'FETCHING…' : 'FETCH MODELS'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="section-label">SCAN TIMING</div>
        <div className="form-group">
          <label className="field-label">SCAN EVERY <span className="amber">{scanEvery}s</span></label>
          <input id="scan-range" type="range" className="dc-slider" min="2" max="30" step="1" value={scanEvery} onChange={e => setScanEvery(Number(e.target.value))} />
          <div className="field-hint">Slower = fewer inferences = lower cost</div>
        </div>
        <div className="form-group">
          <label className="field-label">COST RATE ($/1M tokens)</label>
          <input id="rate" type="number" className="dc-input narrow" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)} />
        </div>
      </div>

      <div className="settings-section">
        <div className="section-label">VIBRATION</div>
        <button id="vibe-test" className="dc-btn" disabled={!canVibrate} onClick={handleVibeTest}>TEST VIBRATION</button>
        {!canVibrate && <p className="field-hint">Vibration not supported on this browser/device (e.g. iOS Safari).</p>}
        {vibeStatus && <p id="vibe-status" className="status-msg" role="status">{vibeStatus}</p>}
      </div>

      <div className="settings-section">
        <div className="section-label">WEBHOOK</div>
        <div className="form-group">
          <label className="field-label">URL</label>
          <input id="webhook-url" type="url" className="dc-input" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://ntfy.sh/mytopic" />
        </div>
        <div className="form-group inline-row">
          <div style={{ flex: 1 }}>
            <label className="field-label">METHOD</label>
            <select id="webhook-method" className="dc-select" value={webhookMethod} onChange={e => setWebhookMethod(e.target.value)}>
              <option value="POST">POST</option>
              <option value="GET">GET</option>
              <option value="PUT">PUT</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>
          <button id="webhook-test" className="dc-btn" onClick={handleWebhookTest}>TEST</button>
        </div>
        {webhookStatus && <p id="webhook-status" className="status-msg" role="status">{webhookStatus}</p>}
        <div className="form-group">
          <label className="field-label">HEADERS (JSON)</label>
          <textarea id="webhook-headers" className="dc-textarea" rows={2} value={webhookHeaders} onChange={e => setWebhookHeaders(e.target.value)} placeholder='{"Authorization": "Bearer tk_xxxx"}' />
        </div>
        <div className="form-group">
          <label className="field-label">BODY ACTION PROMPT</label>
          <textarea id="webhook-action" className="dc-textarea" rows={2} value={webhookAction} onChange={e => setWebhookAction(e.target.value)} placeholder="e.g. Include the alert reason, confidence level, and a timestamp." />
        </div>
        <div className="form-group">
          <label className="field-label">BODY JSON SCHEMA (optional)</label>
          <textarea id="webhook-schema" className="dc-textarea" rows={3} value={webhookSchema} onChange={e => setWebhookSchema(e.target.value)} placeholder='{"type":"object","required":["message"],"properties":{"message":{"type":"string"}}}' />
        </div>
      </div>
    </div>
  );
}
