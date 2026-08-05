import { useState } from 'react';
import { fetchModels, isLocalBaseUrl, sameOrigin } from '../../lib/aura.js';
import { testVibration, canVibrate } from '../../public/feedback.js';

// One-click base URLs. The local ones need no API key, and cost nothing —
// picking one zeroes the cost rate so the telemetry doesn't invent dollars.
const PROVIDER_PRESETS = [
  { id: 'ollama', label: 'OLLAMA', url: 'http://localhost:11434/v1', local: true },
  { id: 'lmstudio', label: 'LM STUDIO', url: 'http://localhost:1234/v1', local: true },
  { id: 'llamacpp', label: 'LLAMA.CPP', url: 'http://localhost:8080/v1', local: true },
  { id: 'cerebras', label: 'CEREBRAS', url: 'https://api.cerebras.ai/v1', local: false },
];

const SCAN_MODES = [
  { id: 'interval', label: 'INTERVAL' },
  { id: 'max', label: 'MAX' },
  { id: 'budget', label: 'BUDGET' },
];

const SCAN_EVERY_UNITS = [
  { id: 's', label: 'SEC', seconds: 1 },
  { id: 'm', label: 'MIN', seconds: 60 },
  { id: 'h', label: 'HR', seconds: 3600 },
];

export default function SettingsScreen({
  baseUrl, setBaseUrl,
  apiKey, setApiKey,
  model, setModel,
  scanMode, setScanMode,
  scanEveryValue, setScanEveryValue,
  scanEveryUnit, setScanEveryUnit,
  budgetPerHour, setBudgetPerHour,
  networkMbPerHour, setNetworkMbPerHour,
  rate, setRate,
  videoSource, setVideoSource,
  cameraFacing, setCameraFacing,
  cameraDeviceId, setCameraDeviceId,
  webhookUrl, setWebhookUrl,
  webhookMethod, setWebhookMethod,
  webhookHeaders, setWebhookHeaders,
  webhookAction, setWebhookAction,
  webhookSchema, setWebhookSchema,
  statusMsg,
  onStatusMsg,
}) {
  const [models, setModels] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [vibeStatus, setVibeStatus] = useState('');
  const [webhookStatus, setWebhookStatus] = useState('');
  const [cameras, setCameras] = useState([]);
  const [cameraStatus, setCameraStatus] = useState('');

  // No API-key guard: a local server lists its models without one.
  async function handleFetchModels() {
    if (!baseUrl) { onStatusMsg('Enter a Base URL first.'); return; }
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

  // Switching providers drops the stored key. Keeping it would send one
  // provider's credential to another endpoint on the very next request —
  // a Cerebras key to localhost, or an OpenAI key to Cerebras. Re-picking the
  // provider that's already configured leaves the key alone.
  function selectPreset(preset) {
    if (apiKey && !sameOrigin(baseUrl, preset.url)) {
      setApiKey('');
      onStatusMsg(`Switched provider — API key cleared. Enter ${preset.label}'s key if it needs one.`);
    }
    setBaseUrl(preset.url);
    setModels([]);
    if (preset.local) setRate('0');
  }

  const isLocal = isLocalBaseUrl(baseUrl);

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

  // Device labels are blank until camera permission is granted — request a
  // throwaway stream first, stop it, then enumerate the video inputs.
  async function handleDetectCameras() {
    setCameraStatus('Requesting camera permission…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      setCameras(cams);
      setCameraStatus(`Found ${cams.length} camera${cams.length === 1 ? '' : 's'}.`);
    } catch (err) {
      setCameraStatus(`Camera detection failed: ${err.message}`);
    }
  }

  return (
    <div className="screen screen-settings">
      <div className="screen-header">
        <span className="screen-title">SYSTEM SETTINGS</span>
      </div>

      <div className="settings-section">
        <div className="section-label">PROVIDER</div>
        <div className="form-group">
          <label className="field-label">PRESET</label>
          <div className="mode-segments" role="group" aria-label="Provider preset">
            {PROVIDER_PRESETS.map(p => (
              <button
                key={p.id}
                className={`mode-segment ${baseUrl === p.url ? 'active' : ''}`}
                onClick={() => selectPreset(p)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="form-group">
          <label className="field-label">BASE URL</label>
          <input id="provider-baseurl" type="url" className="dc-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.cerebras.ai/v1" />
          {isLocal && (
            <div className="field-hint">
              Local server — allow this page's origin in its CORS config
              (<code>OLLAMA_ORIGINS='*'</code> for Ollama, <code>--cors</code> for llama-server).
              Prefer <code>localhost</code> or <code>127.0.0.1</code>: browsers block <code>0.0.0.0</code> as a request target.
            </div>
          )}
        </div>
        <div className="form-group">
          <label className="field-label">API KEY</label>
          <input id="provider-apikey" type="password" className="dc-input" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="blank for a local server" />
          <div className="field-hint">Leave blank for a local server (Ollama, LM Studio, llama.cpp) that needs no key — no Authorization header is sent.</div>
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
        {statusMsg && <p id="provider-status" className="status-msg" role="status">{statusMsg}</p>}
      </div>

      <div className="settings-section">
        <div className="section-label">SCAN TIMING</div>
        <div className="form-group">
          <label className="field-label">MODE</label>
          <div className="mode-segments" role="radiogroup" aria-label="Scan timing mode">
            {SCAN_MODES.map(m => (
              <button
                key={m.id}
                className={`mode-segment ${scanMode === m.id ? 'active' : ''}`}
                role="radio"
                aria-checked={scanMode === m.id}
                onClick={() => setScanMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="field-hint">
            {scanMode === 'max' && 'Freshest image, max frame rate — for free local models (Ollama, LM Studio).'}
            {scanMode === 'budget' && 'Cadence derived from your spend / data caps — for cloud within a budget.'}
            {scanMode !== 'max' && scanMode !== 'budget' && 'Fixed gap between scans — predictable cadence.'}
          </div>
        </div>
        {scanMode === 'interval' && (
          <div className="form-group">
            <label className="field-label">SCAN EVERY</label>
            <div className="inline-row">
              <input
                id="scan-every-value"
                type="number"
                className="dc-input narrow"
                min="1"
                step="any"
                value={scanEveryValue}
                onChange={e => setScanEveryValue(e.target.value)}
              />
              <select
                id="scan-every-unit"
                className="dc-select"
                value={scanEveryUnit}
                onChange={e => setScanEveryUnit(e.target.value)}
              >
                {SCAN_EVERY_UNITS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
              </select>
            </div>
            <div className="field-hint">Slower = fewer inferences = lower cost. Anywhere from 1 second to many hours.</div>
          </div>
        )}
        {scanMode === 'max' && (
          <div className="form-group">
            <div className="field-hint">No forced timeout — each scan runs to completion and the next one starts immediately after, for the highest frame rate the model can sustain.</div>
          </div>
        )}
        {scanMode === 'budget' && (
          <>
            <div className="form-group">
              <label className="field-label">MAX $/HOUR</label>
              <input id="budget-per-hour" type="number" className="dc-input narrow" min="0" step="0.01" value={budgetPerHour} onChange={e => setBudgetPerHour(e.target.value)} />
              <div className="field-hint">Spend cap — needs the COST RATE below and a provider that reports token usage.</div>
            </div>
            <div className="form-group">
              <label className="field-label">MAX MB/HOUR</label>
              <input id="network-mb-per-hour" type="number" className="dc-input narrow" min="0" step="1" value={networkMbPerHour} onChange={e => setNetworkMbPerHour(e.target.value)} placeholder="off" />
              <div className="field-hint">Upload cap for mobile data — blank = off. The most restrictive cap wins.</div>
            </div>
          </>
        )}
        {scanMode !== 'max' && (
          <div className="form-group">
            <div className="field-hint">Per-request timeout is fully automatic: mean + 3 standard deviations of this session's own successful response times (shown as TIMEOUT on the Monitor tab). No manual setting needed.</div>
          </div>
        )}
        {(scanMode === 'interval' || scanMode === 'budget') && (
          <div className="form-group">
            <label className="field-label">COST RATE ($/1M tokens)</label>
            <input id="rate" type="number" className="dc-input narrow" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)} />
          </div>
        )}
      </div>

      <div className="settings-section">
        <div className="section-label">CAMERA</div>
        <div className="form-group">
          <label className="field-label">SOURCE</label>
          <select id="video-source" className="dc-select" value={videoSource} onChange={e => setVideoSource(e.target.value)}>
            <option value="camera">CAMERA</option>
            <option value="screen">SCREEN SHARE</option>
          </select>
          {videoSource === 'screen' && (
            <div className="field-hint">Screen share needs a fresh browser prompt each time you arm, and is effectively desktop-only. Monitoring stops when you stop sharing.</div>
          )}
        </div>
        {videoSource !== 'screen' && (
          <>
            <div className="form-group">
              <label className="field-label">FACING</label>
              <div className="mode-segments" role="radiogroup" aria-label="Camera facing">
                <button
                  className={`mode-segment ${cameraFacing === 'environment' ? 'active' : ''}`}
                  role="radio" aria-checked={cameraFacing === 'environment'}
                  onClick={() => { setCameraFacing('environment'); setCameraDeviceId(''); }}
                >
                  BACK
                </button>
                <button
                  className={`mode-segment ${cameraFacing === 'user' ? 'active' : ''}`}
                  role="radio" aria-checked={cameraFacing === 'user'}
                  onClick={() => { setCameraFacing('user'); setCameraDeviceId(''); }}
                >
                  FRONT
                </button>
              </div>
              <div className="field-hint">Used when DEVICE is AUTO. Picking a specific device below overrides it.</div>
            </div>
            <div className="form-group inline-row">
              <div style={{ flex: 1 }}>
                <label className="field-label">DEVICE</label>
                <select id="camera-device" className="dc-select" value={cameraDeviceId} onChange={e => setCameraDeviceId(e.target.value)}>
                  <option value="">AUTO (by facing)</option>
                  {/* Keep a previously saved device selectable before detection runs. */}
                  {cameraDeviceId && !cameras.some(c => c.deviceId === cameraDeviceId) && (
                    <option value={cameraDeviceId}>SAVED DEVICE</option>
                  )}
                  {cameras.map((c, i) => (
                    <option key={c.deviceId} value={c.deviceId}>{c.label || `Camera ${i + 1}`}</option>
                  ))}
                </select>
              </div>
              <button id="detect-cameras-btn" className="dc-btn" onClick={handleDetectCameras}>DETECT CAMERAS</button>
            </div>
            {cameraStatus && <p id="camera-status" className="status-msg" role="status">{cameraStatus}</p>}
          </>
        )}
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
