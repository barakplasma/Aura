import { useEffect, useState } from 'react';
import {
  BROWSER_MODELS, DEFAULT_BROWSER_MODEL, FALLBACK_BROWSER_MODEL, browserModelKeys, modelKnownIssue,
  modelUnsupportedReason, pickBrowserModel, probeBrowserEnv, probeChromeAI, resolveBrowserRuntime,
  loadBrowserModel, clearBrowserModelCache, isBrowserModelLoaded, browserModelDevice, browserDeviceLimits,
} from '../../lib/browser-engine.js';
import { reportHandledError } from '../monitoring.js';
import ProgressBar from '../components/ProgressBar.jsx';
import { Button } from '../ui/button.jsx';
import { Field } from '../ui/field.jsx';
import { Select } from '../ui/input.jsx';
import { Status } from '../ui/status.jsx';

// What the Chrome built-in AI probe means for the runtime the operator picked.
function runtimeHint(runtime, chromeEnv) {
  if (!chromeEnv) return 'Probing this browser…';
  const nano = chromeEnv.imageCapable && chromeEnv.availability === 'available';
  if (runtime === 'chrome-ai') {
    return nano
      ? 'Chrome built-in AI selected. Gemini Nano runs every scan on-device with JSON-constrained output.'
      : `Chrome built-in AI selected, but this browser reports "${chromeEnv.availability}"${chromeEnv.imageCapable ? '' : ' without image input'} — scans will fail until Gemini Nano is downloaded and multimodal here. Transformers.js stays available.`;
  }
  if (runtime === 'transformers') return 'Transformers.js selected — the model below answers every scan.';
  if (chromeEnv.resolved === 'chrome-ai') {
    return 'Auto → Chrome built-in AI. Gemini Nano runs every scan on-device with JSON-constrained output — no model download here.';
  }
  if (chromeEnv.availability === 'downloadable' || chromeEnv.availability === 'downloading') {
    return `Auto → Transformers.js. Chrome built-in AI exists here but its model is ${chromeEnv.availability} — selecting it above triggers the ~2 GB Gemini Nano download. Not available on Chrome for Android.`;
  }
  return 'Auto → Transformers.js. No usable Chrome built-in AI on this browser (absent, not yet downloaded, or text-only).';
}

// Where the loaded model is running, and with how much buffer. WebGPU with
// spec-minimum buffers silently runs WASM, so name the ceiling rather than
// trusting the device label alone — and the ceiling that was asked for too,
// because a clamped grant is a different problem from never having asked.
function deviceSuffix() {
  if (browserModelDevice() === 'wasm') return ' (WASM — no WebGPU, expect it to be slow)';
  const limits = browserDeviceLimits();
  const got = limits?.maxStorageBufferMB;
  if (got == null) return ' (WebGPU)';
  const asked = limits.adapterMaxStorageBufferMB;
  return asked != null && asked > got
    ? ` (WebGPU · ${got} MB of ${asked} MB buffers — larger models fall back to WASM)`
    : ` (WebGPU · ${got} MB buffers)`;
}

// BROWSER engine, step 2: runtime, model, and the download. The frame test is
// step 3, shared with the other engines.
export default function BrowserFields({ s, set }) {
  const hasWebGpu = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  const key = s.browserModel && BROWSER_MODELS[s.browserModel] ? s.browserModel : DEFAULT_BROWSER_MODEL;
  const cfg = BROWSER_MODELS[key];
  const runtime = s.browserRuntime || 'auto';

  // The adapter's buffer limits need an async requestAdapter(), so the probe
  // result arrives after first paint. Null until then — the recommendation
  // line simply isn't shown yet rather than flashing a wrong one.
  const [gpuEnv, setGpuEnv] = useState(null);
  useEffect(() => {
    let live = true;
    probeBrowserEnv().then((env) => { if (live) setGpuEnv(env); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const recommendedKey = gpuEnv ? pickBrowserModel(gpuEnv) : null;

  const [chromeEnv, setChromeEnv] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const probe = await probeChromeAI();
      const resolved = await resolveBrowserRuntime(runtime);
      if (live) setChromeEnv({ ...probe, resolved });
    })().catch(() => {});
    return () => { live = false; };
  }, [runtime]);

  const [downloading, setDownloading] = useState(false);
  const [pct, setPct] = useState(null);
  const [note, setNote] = useState(null);
  const unavailable = Boolean(gpuEnv && cfg.requiresWebGpu && !gpuEnv.hasShaderF16);

  // The stored default can be a WebGPU-only model from a different device.
  // Once the real adapter probe completes, replace an impossible selection
  // with the one verified WASM-capable row instead of leaving a broken model
  // selected and waiting for the user to hit Download.
  useEffect(() => {
    if (unavailable) {
      set.browserModel(FALLBACK_BROWSER_MODEL);
      setNote({ tone: 'warn', text: `${cfg.label} needs WebGPU fp16 here. Switched to SmolVLM2 256M (WASM; slower and more basic).` });
    }
  }, [unavailable, cfg.label, set]);

  async function handleLoad() {
    setDownloading(true);
    setPct(null);
    setNote(null);
    try {
      const { device } = await loadBrowserModel(key, { onProgress: (m) => { if (m.pct != null) setPct(m.pct); } });
      set.browserModel(key);
      setNote(device === 'webgpu'
        ? { tone: 'ok', text: 'Model ready (WebGPU).' }
        : { tone: 'warn', text: 'Model ready — running on WASM (no WebGPU, expect it to be slow).' });
    } catch (err) {
      reportHandledError(err, { area: 'browser-model-load', inference: 'in-browser', model: key, phase: 'model-load', ...(err.browserContext || {}) });
      setNote({ tone: 'danger', text: `Load failed: ${err.message}` });
    } finally {
      setDownloading(false);
      setPct(null);
    }
  }

  async function handleClear() {
    setNote({ tone: 'neutral', text: 'Clearing…' });
    try {
      await clearBrowserModelCache();
      setNote({ tone: 'ok', text: `Cache cleared — ${cfg.sizeLabel} freed.` });
    } catch (err) {
      setNote({ tone: 'danger', text: `Clear failed: ${err.message}` });
    }
  }

  const issue = modelKnownIssue(key);
  const loaded = isBrowserModelLoaded(key);
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Runtime"
        htmlFor="browser-runtime-select"
        hint={<>
          {runtimeHint(runtime, chromeEnv)}
          {chromeEnv?.resolved === 'chrome-ai' && ' The Transformers.js model below stays downloaded but idle while Chrome built-in AI is active.'}
        </>}
      >
        <Select id="browser-runtime-select" value={runtime} onChange={(e) => set.browserRuntime(e.target.value)}>
          <option value="auto">Auto — best available</option>
          <option value="transformers">Transformers.js — WebGPU model</option>
          <option value="chrome-ai">Chrome built-in AI — Gemini Nano</option>
        </Select>
      </Field>

      <Field
        label="In-browser model"
        htmlFor="browser-model-select"
        hint={<>
          {cfg.sizeLabel} download, cached after the first load.{' '}
          {cfg.promptProfile === 'compact'
            ? 'Coarse yes/no detector — too small to follow a written instruction, so announcements fall back to what it saw.'
            : 'Follows the same detection and announcement prompts as the Provider engine.'}
          {issue && <> Known issue: {issue} — it may never finish a scan on similar hardware.</>}
        </>}
      >
        <Select id="browser-model-select" value={key} onChange={(e) => set.browserModel(e.target.value)}>
          {browserModelKeys().map((k) => {
            const row = BROWSER_MODELS[k];
            const why = modelUnsupportedReason(k, gpuEnv ? { hasWebGpu: true, hasShaderF16: gpuEnv.hasShaderF16 } : {});
            const known = modelKnownIssue(k);
            return (
              <option key={k} value={k} disabled={Boolean(why)}>
                {row.label} · {row.sizeLabel}
                {row.promptProfile === 'compact' ? ' · basic' : ''}
                {why ? ` · ${why}` : ''}
                {!why && known ? ` · warning: ${known}` : ''}
              </option>
            );
          })}
        </Select>
        {recommendedKey && recommendedKey !== key && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-text-dim">
            Best fit for this device: {BROWSER_MODELS[recommendedKey].label}.
            <Button id="browser-model-autopick" variant="outline" onClick={() => set.browserModel(recommendedKey)}>Use it</Button>
          </p>
        )}
      </Field>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold">Status</p>
        <Status tone={loaded ? 'ok' : 'neutral'} className="text-sm">
          {downloading
            ? `Downloading ${pct != null ? `${pct}%` : '…'}`
            : loaded ? `Ready${deviceSuffix()}` : 'Not downloaded'}
        </Status>
        {downloading && <ProgressBar phase="processing" pct={pct} label={`Loading ${cfg.label}`} />}
        {!hasWebGpu && !downloading && (
          <Status tone="warn">No WebGPU detected on this browser/device — falls back to WASM, which is much slower (roughly 10-30s per scan).</Status>
        )}
        {gpuEnv?.hasWebGpu && !gpuEnv.hasShaderF16 && !downloading && (
          <Status tone="warn">WebGPU is available, but not fp16. Larger models are unavailable; SmolVLM2 256M can run on WASM.</Status>
        )}
        <div className="flex flex-wrap gap-2">
          <Button id="browser-load-btn" disabled={downloading || unavailable} onClick={handleLoad}>
            {downloading ? 'Loading…' : 'Download / load'}
          </Button>
          <Button id="browser-clear-btn" variant="outline" onClick={handleClear}>Clear model cache</Button>
        </div>
        <Status id="browser-model-status" tone={note?.tone}>{note?.text}</Status>
      </div>
    </div>
  );
}
