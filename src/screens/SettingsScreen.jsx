import { useState, useEffect, useCallback } from 'react';
import { IonContent } from '@ionic/react';
import { fetchModels, isLocalBaseUrl, sameOrigin } from '../../lib/aura.js';
import { PROVIDER_PRESETS, providerForUrl } from '../../lib/providers.js';
import {
  BROWSER_MODELS,
  DEFAULT_BROWSER_MODEL,
  FALLBACK_BROWSER_MODEL,
  browserModelKeys,
  pickBrowserModel,
  probeBrowserEnv,
  probeChromeAI,
  resolveBrowserRuntime,
  loadBrowserModel,
  clearBrowserModelCache,
  isBrowserModelLoaded,
  browserModelDevice,
  scanBrowser,
} from '../../lib/browser-engine.js';
import { testVibration, canVibrate } from '../../public/feedback.js';
import ProgressBar from '../components/ProgressBar.jsx';
import { reportHandledError } from '../monitoring.js';

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
  engine, setEngine,
  browserModel, setBrowserModel,
  browserRuntime, setBrowserRuntime,
  baseUrl, setBaseUrl,
  apiKey, setApiKey,
  model, setModel,
  captureFrame,
  scanMode, setScanMode,
  scanEveryValue, setScanEveryValue,
  scanEveryUnit, setScanEveryUnit,
  budgetPerHour, setBudgetPerHour,
  networkMbPerHour, setNetworkMbPerHour,
  pricing, pricingOverride, onSetPricingOverride, onResetPricingOverride,
  videoSource, setVideoSource,
  captureSize, setCaptureSize,
  customCaptureWidth, setCustomCaptureWidth,
  customCaptureHeight, setCustomCaptureHeight,
  cameraFacing, setCameraFacing,
  cameraDeviceId, setCameraDeviceId,
  keepScreenOn, setKeepScreenOn,
  webhookUrl, setWebhookUrl,
  webhookMethod, setWebhookMethod,
  webhookHeaders, setWebhookHeaders,
  webhookAction, setWebhookAction,
  webhookSchema, setWebhookSchema,
  webhookIncludeImage, setWebhookIncludeImage,
  statusMsg,
  onStatusMsg,
}) {
  const [models, setModels] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [providerQuery, setProviderQuery] = useState(() => providerForUrl(baseUrl)?.label || '');
  const [showProviderDropdown, setShowProviderDropdown] = useState(false);
  const [vibeStatus, setVibeStatus] = useState('');
  const [webhookStatus, setWebhookStatus] = useState('');
  const [cameras, setCameras] = useState([]);
  const [cameraStatus, setCameraStatus] = useState('');

  function setManualRate(field, value) {
    const other = field === 'inputRate' ? 'outputRate' : 'inputRate';
    const fallback = pricingOverride?.[other] ?? pricing?.[other] ?? '';
    onSetPricingOverride({ ...pricingOverride, [field]: value, [other]: fallback });
  }

  // BROWSER MODEL — see lib/browser-models.js for the table and the picker.
  const browserModelKey =
    browserModel && BROWSER_MODELS[browserModel] ? browserModel : DEFAULT_BROWSER_MODEL;
  const browserModelCfg = BROWSER_MODELS[browserModelKey];
  const hasWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  // The adapter's buffer limits need an async requestAdapter(), so the probe
  // result arrives after first paint. Null until then — the recommendation
  // line simply isn't shown yet rather than flashing a wrong one.
  const [gpuEnv, setGpuEnv] = useState(null);
  useEffect(() => {
    let live = true;
    probeBrowserEnv().then((env) => { if (live) setGpuEnv(env); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    setProviderQuery(providerForUrl(baseUrl)?.label || '');
  }, [baseUrl]);
  const recommendedKey = gpuEnv ? pickBrowserModel(gpuEnv) : null;
  const [downloading, setDownloading] = useState(false);
  const [downloadPct, setDownloadPct] = useState(null);
  const [browserModelStatus, setBrowserModelStatus] = useState('');
  const [testingBrowser, setTestingBrowser] = useState(false);
  const [browserTestResult, setBrowserTestResult] = useState(null);
  const browserModelUnavailable = Boolean(
    gpuEnv && browserModelCfg.requiresWebGpu && !gpuEnv.hasShaderF16,
  );

  // The stored default can be a WebGPU-only model from a different device.
  // Once the real adapter probe completes, replace an impossible selection
  // with the one verified WASM-capable row instead of leaving a broken model
  // selected and waiting for the user to hit Download.
  useEffect(() => {
    if (browserModelUnavailable && setBrowserModel) {
      setBrowserModel(FALLBACK_BROWSER_MODEL);
      setBrowserModelStatus(
        `${browserModelCfg.label} needs WebGPU fp16 here. Switched to SmolVLM2 256M (WASM; slower and more basic).`,
      );
    }
  }, [browserModelUnavailable, browserModelCfg.label, setBrowserModel]);

  // Chrome built-in AI (Gemini Nano) — what can this browser do right now,
  // and which runtime does the current selection resolve to? Same async-probe
  // pattern as gpuEnv above: null until resolved, nothing flashed early.
  const [chromeEnv, setChromeEnv] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const probe = await probeChromeAI();
      const resolved = await resolveBrowserRuntime(browserRuntime || 'auto');
      if (live) setChromeEnv({ ...probe, resolved });
    })().catch(() => {});
    return () => { live = false; };
  }, [browserRuntime]);

  async function handleLoadBrowserModel() {
    setDownloading(true);
    setDownloadPct(null);
    setBrowserModelStatus('');
    try {
      const { device } = await loadBrowserModel(browserModelKey, {
        onProgress: (msg) => { if (msg.pct != null) setDownloadPct(msg.pct); },
      });
      if (setBrowserModel) setBrowserModel(browserModelKey);
      setBrowserModelStatus(
        device === 'webgpu' ? 'Model ready (WebGPU).' : 'Model ready — running on WASM (no WebGPU, expect it to be slow).',
      );
    } catch (err) {
      reportHandledError(err, {
        area: 'browser-model-load', inference: 'in-browser', model: browserModelKey,
        phase: 'model-load', ...(err.browserContext || {}),
      });
      setBrowserModelStatus(`Load failed: ${err.message}`);
    } finally {
      setDownloading(false);
      setDownloadPct(null);
    }
  }

  async function handleTestBrowserModel() {
    const frame = captureFrame?.();
    if (!frame) {
      setBrowserModelStatus('Start monitoring first — the camera stage must be live to capture a frame.');
      return;
    }
    setTestingBrowser(true);
    setBrowserTestResult(null);
    try {
      const result = await scanBrowser({
        model: browserModelKey,
        runtime: browserRuntime || 'auto',
        mission: 'anything unusual, unsafe, or noteworthy',
        image: frame,
        threshold: 0,
        onProgress: (msg) => { if (msg.pct != null) setDownloadPct(msg.pct); },
      });
      setBrowserTestResult(result);
    } catch (err) {
      reportHandledError(err, {
        area: 'browser-model-test', inference: 'in-browser', model: browserModelKey,
        phase: 'inference', ...(err.browserContext || {}),
      });
      setBrowserModelStatus(`Test failed: ${err.message}`);
    } finally {
      setTestingBrowser(false);
    }
  }

  async function handleClearBrowserCache() {
    setBrowserModelStatus('Clearing…');
    try {
      await clearBrowserModelCache();
      setBrowserTestResult(null);
      setBrowserModelStatus(`Cache cleared — ${browserModelCfg.sizeLabel} freed.`);
    } catch (err) {
      setBrowserModelStatus(`Clear failed: ${err.message}`);
    }
  }

  // No API-key guard: a local server lists its models without one.
  async function handleFetchModels() {
    if (!baseUrl) { onStatusMsg('Enter a Base URL first.'); return; }
    setFetchingModels(true);
    try {
      const list = await fetchModels(baseUrl, apiKey, { visionOnly: true });
      setModels(list);
      setShowDropdown(list.length > 0);
      if (list.length > 0 && !model) setModel(list[0]);
      onStatusMsg(`Found ${list.length} image-capable models.`);
    } catch (err) {
      reportHandledError(err, { area: 'fetch-models', inference: isLocal ? 'local-provider' : 'cloud-provider' });
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
    setProviderQuery(preset.label);
    setShowProviderDropdown(false);
    setModels(preset.models || []);
    if (!model && preset.models?.[0]) setModel(preset.models[0]);
  }

  const isLocal = isLocalBaseUrl(baseUrl);
  const wakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  const filteredModels = models.filter(m => m.toLowerCase().includes((model || '').toLowerCase()));
  const filteredProviders = PROVIDER_PRESETS.filter((provider) =>
    provider.label.toLowerCase().includes(providerQuery.toLowerCase()),
  );

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
    <IonContent className="aura-page screen screen-settings">
      <div className="screen-header">
        <span className="screen-title">SYSTEM SETTINGS</span>
      </div>

      <div className="settings-section">
        <div className="section-label">PROVIDER</div>
        <div className="form-group">
          <label className="field-label">ENGINE</label>
          <div className="mode-segments" role="radiogroup" aria-label="Inference engine">
            <button
              className={`mode-segment ${engine !== 'browser' ? 'active' : ''}`}
              role="radio" aria-checked={engine !== 'browser'}
              onClick={() => setEngine('provider')}
            >
              PROVIDER
            </button>
            <button
              className={`mode-segment ${engine === 'browser' ? 'active' : ''}`}
              role="radio" aria-checked={engine === 'browser'}
              onClick={() => setEngine('browser')}
            >
              BROWSER
            </button>
          </div>
          <div className="field-hint">
            {engine === 'browser'
              ? 'Runs a small vision model on this device via WebGPU — no key, no server, and the frame never leaves the browser.'
              : 'Calls an OpenAI-compatible vision model from a cloud provider or local server you configure below.'}
          </div>
        </div>

        {engine !== 'browser' && (
          <>
            <div className="form-group">
              <label className="field-label" htmlFor="provider-preset">PROVIDER PRESET</label>
              <div className="provider-picker">
                <input
                  id="provider-preset"
                  className="dc-input"
                  value={providerQuery}
                  onFocus={() => setShowProviderDropdown(true)}
                  onChange={(e) => { setProviderQuery(e.target.value); setShowProviderDropdown(true); }}
                  onBlur={() => setTimeout(() => setShowProviderDropdown(false), 150)}
                  placeholder="Search local and remote providers"
                  role="combobox"
                  aria-expanded={showProviderDropdown}
                  aria-controls="provider-dropdown"
                  aria-autocomplete="list"
                />
                {showProviderDropdown && filteredProviders.length > 0 && (
                  <div id="provider-dropdown" className="provider-dropdown" role="listbox">
                    {['Local', 'Remote'].map((group) => {
                      const choices = filteredProviders.filter((provider) => provider.group === group);
                      if (!choices.length) return null;
                      return (
                        <div key={group} className="provider-dropdown-group">
                          <div className="provider-dropdown-label">{group}</div>
                          {choices.map((provider) => (
                            <div
                              key={provider.id}
                              className="provider-dropdown-item"
                              role="option"
                              aria-selected={baseUrl === provider.url}
                              onMouseDown={() => selectPreset(provider)}
                            >
                              {provider.label}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="field-hint">10 local and 10 remote OpenAI-compatible providers. Presets include only vision-ready model suggestions where known.</div>
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
                  placeholder="Search or enter a vision model"
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
                {fetchingModels ? 'FETCHING…' : 'FETCH VISION MODELS'}
              </button>
            </div>
            {statusMsg && <p id="provider-status" className="status-msg" role="status">{statusMsg}</p>}
          </>
        )}

        {engine === 'browser' && (
          <>
            <div className="form-group">
              <label className="field-label" htmlFor="browser-runtime-select">RUNTIME</label>
              <select
                id="browser-runtime-select"
                className="dc-input"
                value={browserRuntime || 'auto'}
                onChange={(e) => setBrowserRuntime?.(e.target.value)}
              >
                <option value="auto">AUTO — best available</option>
                <option value="transformers">TRANSFORMERS.JS — WebGPU model</option>
                <option value="chrome-ai">CHROME BUILT-IN AI — Gemini Nano</option>
              </select>
              <div className="field-hint">
                {!chromeEnv
                  ? 'Probing this browser…'
                  : (browserRuntime || 'auto') === 'chrome-ai'
                    ? (chromeEnv.imageCapable && chromeEnv.availability === 'available'
                        ? 'CHROME BUILT-IN AI selected. Gemini Nano runs every scan on-device with JSON-constrained output.'
                        : `CHROME BUILT-IN AI selected, but this browser reports "${chromeEnv.availability}"${chromeEnv.imageCapable ? '' : ' without image input'} — scans will fail until Gemini Nano is downloaded and multimodal here. Transformers.js stays available above.`)
                    : (browserRuntime || 'auto') === 'transformers'
                      ? 'TRANSFORMERS.JS selected — the model below answers every scan.'
                      : chromeEnv.resolved === 'chrome-ai'
                        ? 'AUTO → CHROME BUILT-IN AI. Gemini Nano runs every scan on-device with JSON-constrained output — no model download here.'
                        : chromeEnv.availability === 'downloadable' || chromeEnv.availability === 'downloading'
                          ? `AUTO → TRANSFORMERS.JS. Chrome built-in AI exists here but its model is ${chromeEnv.availability} — selecting it above triggers the ~2 GB Gemini Nano download. Not available on Chrome for Android.`
                          : 'AUTO → TRANSFORMERS.JS. No usable Chrome built-in AI on this browser (absent, not yet downloaded, or text-only).'}
              </div>
              {chromeEnv?.resolved === 'chrome-ai' && (
                <div className="field-hint">The TRANSFORMERS.JS model below stays downloaded but idle while Chrome built-in AI is active.</div>
              )}
            </div>
            <div className="form-group">
              <label className="field-label" htmlFor="browser-model-select">BROWSER MODEL</label>
              <select
                id="browser-model-select"
                className="dc-input"
                value={browserModelKey}
                onChange={(e) => setBrowserModel?.(e.target.value)}
              >
                {browserModelKeys().map((key) => {
                  const cfg = BROWSER_MODELS[key];
                  const unsupported = Boolean(gpuEnv && cfg.requiresWebGpu && !gpuEnv.hasShaderF16);
                  return (
                  <option key={key} value={key} disabled={unsupported}>
                    {cfg.label} · {cfg.sizeLabel}
                    {cfg.promptProfile === 'compact' ? ' · basic' : ''}
                    {unsupported ? ' · requires WebGPU fp16' : ''}
                  </option>
                  );
                })}
              </select>
              <div className="field-hint">
                {browserModelCfg.sizeLabel} download, cached after the first load.{' '}
                {browserModelCfg.promptProfile === 'compact'
                  ? 'Coarse yes/no detector — too small to follow a written instruction, so announcements fall back to what it saw.'
                  : 'Follows the same detection and announcement prompts as the PROVIDER engine.'}
              </div>
              {recommendedKey && recommendedKey !== browserModelKey && (
                <div className="field-hint">
                  Best fit for this device: {BROWSER_MODELS[recommendedKey].label}.{' '}
                  <button
                    id="browser-model-autopick"
                    type="button"
                    className="dc-btn outline"
                    onClick={() => setBrowserModel?.(recommendedKey)}
                  >
                    USE IT
                  </button>
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="field-label">STATUS</label>
              <p className="status-msg">
                {downloading
                  ? `DOWNLOADING ${downloadPct != null ? `${downloadPct}%` : '…'}`
                  : isBrowserModelLoaded(browserModelKey)
                    ? `READY${browserModelDevice() === 'wasm' ? ' (WASM — no WebGPU, expect it to be slow)' : ' (WebGPU)'}`
                    : 'NOT DOWNLOADED'}
              </p>
              {downloading && (
                <ProgressBar phase="processing" pct={downloadPct} label={`LOADING ${browserModelCfg.label.toUpperCase()}`} />
              )}
              {!hasWebGpu && !downloading && (
                <div className="field-hint">No WebGPU detected on this browser/device — falls back to WASM, which is much slower (roughly 10-30s per scan).</div>
              )}
              {gpuEnv?.hasWebGpu && !gpuEnv.hasShaderF16 && !downloading && (
                <div className="field-hint">WebGPU is available, but not fp16. Larger models are unavailable; SmolVLM2 256M can run on WASM.</div>
              )}
            </div>
            <div className="btn-row">
              <button id="browser-load-btn" className="dc-btn" disabled={downloading || browserModelUnavailable} onClick={handleLoadBrowserModel}>
                {downloading ? 'LOADING…' : 'DOWNLOAD / LOAD'}
              </button>
              <button
                id="browser-test-btn"
                className="dc-btn outline"
                disabled={testingBrowser || browserModelUnavailable}
                onClick={handleTestBrowserModel}
                title={captureFrame ? '' : 'Start monitoring to capture from the camera'}
              >
                {testingBrowser ? 'TESTING…' : 'TEST ON CURRENT FRAME'}
              </button>
              <button id="browser-clear-btn" className="dc-btn outline" onClick={handleClearBrowserCache}>CLEAR MODEL CACHE</button>
            </div>
            {browserTestResult && (
              <p className="status-msg">
                {browserTestResult.triggered ? 'TRIGGERED' : 'clear'} {Math.round(browserTestResult.confidence)}% — "{browserTestResult.reason}" ({browserTestResult.latencyMs}ms)
              </p>
            )}
            {browserModelStatus && <p id="browser-model-status" className="status-msg" role="status">{browserModelStatus}</p>}
          </>
        )}
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
            <label className="field-label">MODEL PRICING ($/1M TOKENS)</label>
            {pricing?.source === 'unavailable' ? (
              <div className="field-hint">No catalogue price found. Enter both rates to enable the dollar budget cap.</div>
            ) : (
              <div className="field-hint">
                {pricing?.source === 'manual'
                  ? 'Manual override for this provider and model.'
                  : `${pricing?.estimated ? 'Upstream estimate' : 'Automatic'} price from ${pricing?.source === 'openrouter' ? 'OpenRouter' : pricing?.source === 'free' ? 'the local engine' : 'llm-prices'}${pricing?.updatedAt ? ` (${pricing.updatedAt})` : ''}.`}
              </div>
            )}
            {pricing?.source !== 'free' && (
              <div className="inline-row">
                <input id="input-rate" aria-label="Input cost per million tokens" type="number" className="dc-input narrow" min="0" step="0.0001" placeholder={`input ${pricing?.inputRate ?? '—'}`} value={pricingOverride?.inputRate ?? ''} onChange={e => setManualRate('inputRate', e.target.value)} />
                <input id="output-rate" aria-label="Output cost per million tokens" type="number" className="dc-input narrow" min="0" step="0.0001" placeholder={`output ${pricing?.outputRate ?? '—'}`} value={pricingOverride?.outputRate ?? ''} onChange={e => setManualRate('outputRate', e.target.value)} />
                {pricingOverride && <button type="button" className="dc-btn outline" onClick={onResetPricingOverride}>USE AUTO</button>}
              </div>
            )}
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
        <div className="form-group">
          <label className="field-label" htmlFor="capture-size">SCAN IMAGE SIZE</label>
          <select id="capture-size" className="dc-select" value={captureSize} onChange={e => setCaptureSize(e.target.value)}>
            <option value="640x480">640 × 480 (DEFAULT)</option>
            <option value="512x384">512 × 384</option>
            <option value="320x240">320 × 240</option>
            <option value="1280x720">1280 × 720 (HD)</option>
            <option value="1920x1080">1920 × 1080 (FULL HD)</option>
            <option value="custom">CUSTOM</option>
          </select>
          <div className="field-hint">Smaller images use less upload data and may reduce model tokens. Small details may be harder to detect.</div>
        </div>
        {captureSize === 'custom' && (
          <div className="form-group">
            <label className="field-label">CUSTOM SIZE</label>
            <div className="inline-row">
              <input id="custom-capture-width" type="number" className="dc-input narrow" min="64" max="4096" value={customCaptureWidth} onChange={e => setCustomCaptureWidth(e.target.value)} />
              <span>×</span>
              <input id="custom-capture-height" type="number" className="dc-input narrow" min="64" max="4096" value={customCaptureHeight} onChange={e => setCustomCaptureHeight(e.target.value)} />
            </div>
            <div className="field-hint">64–4096 pixels per side, 8 MP maximum. New camera capture requests apply when you next arm; encoding changes on the next scan.</div>
          </div>
        )}
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
        <div className="form-group">
          <label className="toggle-label">
            <input
              id="keep-screen-on-toggle"
              type="checkbox"
              className="dc-checkbox"
              checked={keepScreenOn}
              onChange={e => setKeepScreenOn(e.target.checked)}
            />
            <span>KEEP SCREEN ON</span>
          </label>
          <div className="field-hint">
            Holds a screen wake lock while armed so the phone doesn't sleep and freeze the camera.
            {!wakeLockSupported && ' This browser has no Wake Lock API — the screen may still sleep regardless.'}
          </div>
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
        <label className="toggle-label">
          <input
            id="webhook-include-image"
            type="checkbox"
            className="dc-checkbox"
            checked={webhookIncludeImage}
            onChange={e => setWebhookIncludeImage(e.target.checked)}
          />
          <span>ATTACH LATEST FRAME TO NTFY ALERTS</span>
        </label>
        <p className="field-hint">For hosted ntfy topic URLs (https://ntfy.sh/topic). Aura uploads the alert JPEG with the generated alert text.</p>
      </div>
    </IonContent>
  );
}
