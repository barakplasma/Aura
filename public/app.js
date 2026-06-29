// Aura monitor client — turn the camera into an automated detect→act→webhook loop.
//
//   getUserMedia -> hidden <canvas> (640x480, JPEG q~0.4)
//     -> POST /api/scan { mission, action, image, threshold, webhookAction, webhookSchema }
//       -> { triggered, confidence, reason, message, webhookMessage }
//         -> on alert: speak the announcement + vibrate + log + fire webhook
//
// One request is in flight at a time; the next scan is scheduled after the
// configured interval. Any result that resolves after Stop is discarded.

import { alert as alertOut, resetFeedback, testVibration, canVibrate } from './feedback.js';

const CAPTURE_W = 640;
const CAPTURE_H = 480;
const JPEG_QUALITY = 0.4;

const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('canvas'),
  flash: document.getElementById('flash'),
  status: document.getElementById('status'),
  mission: document.getElementById('mission'),
  action: document.getElementById('action'),
  toggle: document.getElementById('toggle'),
  thresholdRange: document.getElementById('threshold-range'),
  thresholdVal: document.getElementById('threshold-val'),
  scanRange: document.getElementById('scan-range'),
  scanVal: document.getElementById('scan-val'),
  speechToggle: document.getElementById('speech-toggle'),
  hapticsToggle: document.getElementById('haptics-toggle'),
  vibeTest: document.getElementById('vibe-test'),
  vibeStatus: document.getElementById('vibe-status'),
  rate: document.getElementById('rate'),
  webhookUrl: document.getElementById('webhook-url'),
  webhookMethod: document.getElementById('webhook-method'),
  webhookHeaders: document.getElementById('webhook-headers'),
  webhookAction: document.getElementById('webhook-action'),
  webhookSchema: document.getElementById('webhook-schema'),
  webhookTest: document.getElementById('webhook-test'),
  webhookStatus: document.getElementById('webhook-status'),
  latency: document.getElementById('latency'),
  confidence: document.getElementById('confidence'),
  mode: document.getElementById('mode'),
  tokens: document.getElementById('tokens'),
  cost: document.getElementById('cost'),
  alertLog: document.getElementById('alert-log'),
};

const ctx = els.canvas.getContext('2d', { willReadFrequently: true });

const state = {
  running: false,
  stream: null,
  inFlight: false,
  loopTimer: null,
  threshold: 60,
  scanEverySec: 5,
  totalTokens: 0,
};

// --- Camera ---------------------------------------------------------------

async function startCamera() {
  state.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: CAPTURE_W },
      height: { ideal: CAPTURE_H },
    },
  });
  els.video.srcObject = state.stream;
  await els.video.play();
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  els.video.srcObject = null;
}

function captureFrame() {
  ctx.drawImage(els.video, 0, 0, CAPTURE_W, CAPTURE_H);
  return els.canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

// --- Scan loop ------------------------------------------------------------

async function tick() {
  if (!state.running) return;

  if (!state.inFlight && els.video.readyState >= 2) {
    state.inFlight = true;
    const started = performance.now();
    try {
      const whAction = els.webhookAction.value.trim();
      const whSchema = parseWebhookSchema();
      const result = await postScan({
        mission: els.mission.value.trim(),
        action: els.action.value.trim(),
        image: captureFrame(),
        threshold: state.threshold,
        webhookAction: whAction || undefined,
        webhookSchema: whSchema || undefined,
      });
      if (!state.running) return; // discard results that land after Stop
      const rtt = Math.round(performance.now() - started);
      els.latency.textContent = String(result.latencyMs ?? rtt);
      els.mode.textContent = result.mode || '—';
      els.confidence.textContent =
        Number.isFinite(result.confidence) ? String(Math.round(result.confidence)) : '—';
      recordUsage(result.usage);
      handleResult(result);
    } catch (err) {
      if (state.running) els.status.textContent = `Error: ${err.message}`;
    } finally {
      state.inFlight = false;
    }
  }

  if (state.running) {
    state.loopTimer = setTimeout(tick, state.scanEverySec * 1000);
  }
}

async function postScan(body) {
  const resp = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const b = await resp.json().catch(() => ({}));
    throw new Error(b.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

function handleResult(result) {
  if (result.triggered) {
    els.status.textContent = `⚠ ALERT — ${result.message || result.reason}`;
    flashAlert();
    logAlert(result.message || result.reason, result.confidence);
    alertOut(result.message || result.reason, {
      speech: els.speechToggle.checked,
      haptics: els.hapticsToggle.checked,
    });
    if (result.webhookMessage) {
      sendWebhook(result.webhookMessage);
    }
  } else {
    els.status.textContent = `Watching — ${result.reason}`;
  }
}

function flashAlert() {
  els.flash.classList.add('on');
  setTimeout(() => els.flash.classList.remove('on'), 700);
}

function sendWebhook(body) {
  const url = els.webhookUrl.value.trim();
  if (!url) return;

  let parsedBody = body;
  let schemaOk = true;
  const schema = parseWebhookSchema();
  if (schema) {
    try {
      const obj = typeof body === 'string' ? JSON.parse(body) : body;
      schemaOk = validateAgainstSchema(obj, schema);
    } catch {}
  }

  let headers = { 'Content-Type': 'application/json' };
  try {
    const custom = JSON.parse(els.webhookHeaders.value.trim() || '{}');
    if (custom && typeof custom === 'object') {
      headers = { ...headers, ...custom };
    }
  } catch {}

  const method = els.webhookMethod.value;

  fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : parsedBody,
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

function parseWebhookSchema() {
  const raw = els.webhookSchema.value.trim();
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

function validateAgainstSchema(obj, schema) {
  if (!schema || typeof schema !== 'object') return true;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in obj)) return false;
  }
  if (schema.type === 'object' && schema.properties) {
    for (const [key, def] of Object.entries(schema.properties)) {
      if (key in obj && def.type) {
        const val = obj[key];
        const t = typeof val;
        if (def.type === 'string' && t !== 'string' && t !== 'undefined') return false;
        if (def.type === 'number' && t !== 'number') return false;
        if (def.type === 'boolean' && t !== 'boolean') return false;
        if (def.type === 'object' && (t !== 'object' || val === null)) return false;
        if (def.type === 'array' && !Array.isArray(val)) return false;
        if (def.type === 'integer' && (!Number.isInteger(val))) return false;
      }
    }
  }
  return true;
}

function logAlert(message, confidence) {
  const li = document.createElement('li');
  const time = new Date().toLocaleTimeString();
  const conf = Number.isFinite(confidence) ? ` (${Math.round(confidence)}%)` : '';
  li.textContent = `${time}${conf} — ${message}`;
  els.alertLog.prepend(li);
  while (els.alertLog.children.length > 20) els.alertLog.lastChild.remove();
}

// --- Cost telemetry -------------------------------------------------------

function recordUsage(usage) {
  const t = usage && Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0;
  if (!t) return;
  state.totalTokens += t;
  els.tokens.textContent = state.totalTokens.toLocaleString();
  renderCost();
}

function renderCost() {
  const rate = parseFloat(els.rate.value); // $ per 1M tokens
  const cost = (state.totalTokens / 1e6) * (Number.isFinite(rate) && rate >= 0 ? rate : 0);
  els.cost.textContent = cost.toFixed(4);
}

// --- Lifecycle ------------------------------------------------------------

async function start() {
  if (!els.mission.value.trim()) {
    els.status.textContent = 'Describe the mission (what to watch for) first.';
    els.mission.focus();
    return;
  }
  try {
    els.status.textContent = 'Starting camera…';
    await startCamera();
  } catch (err) {
    els.status.textContent = `Camera unavailable: ${err.message}`;
    return;
  }
  state.running = true;
  els.toggle.textContent = 'Stop monitoring';
  els.toggle.classList.add('active');
  els.toggle.setAttribute('aria-pressed', 'true');
  els.status.textContent = 'Monitoring…';
  resetFeedback();
  tick();
}

function stop() {
  state.running = false;
  clearTimeout(state.loopTimer);
  stopCamera();
  resetFeedback();
  els.toggle.textContent = 'Start monitoring';
  els.toggle.classList.remove('active');
  els.toggle.setAttribute('aria-pressed', 'false');
  els.status.textContent = 'Stopped.';
}

els.toggle.addEventListener('click', () => (state.running ? stop() : start()));

// --- Settings -------------------------------------------------------------

function setupControls() {
  const savedThreshold = parseInt(localStorage.getItem('aura.threshold'), 10);
  if (savedThreshold >= 10 && savedThreshold <= 95) state.threshold = savedThreshold;
  const savedScan = parseInt(localStorage.getItem('aura.scanEvery'), 10);
  if (savedScan >= 2 && savedScan <= 30) state.scanEverySec = savedScan;
  const savedRate = localStorage.getItem('aura.rate');
  if (savedRate !== null) els.rate.value = savedRate;
  els.mission.value = localStorage.getItem('aura.mission') || '';
  els.action.value = localStorage.getItem('aura.action') || '';

  els.thresholdRange.value = String(state.threshold);
  els.thresholdVal.textContent = String(state.threshold);
  els.scanRange.value = String(state.scanEverySec);
  els.scanVal.textContent = String(state.scanEverySec);

  els.thresholdRange.addEventListener('input', () => {
    state.threshold = parseInt(els.thresholdRange.value, 10) || 60;
    els.thresholdVal.textContent = String(state.threshold);
    localStorage.setItem('aura.threshold', String(state.threshold));
  });
  els.scanRange.addEventListener('input', () => {
    state.scanEverySec = parseInt(els.scanRange.value, 10) || 5;
    els.scanVal.textContent = String(state.scanEverySec);
    localStorage.setItem('aura.scanEvery', String(state.scanEverySec));
  });
  els.rate.addEventListener('input', () => {
    localStorage.setItem('aura.rate', els.rate.value);
    renderCost();
  });
  els.mission.addEventListener('input', () =>
    localStorage.setItem('aura.mission', els.mission.value)
  );
  els.action.addEventListener('input', () =>
    localStorage.setItem('aura.action', els.action.value)
  );

  if (!canVibrate) {
    els.vibeTest.disabled = true;
    els.hapticsToggle.checked = false;
    els.hapticsToggle.disabled = true;
    els.vibeStatus.textContent =
      'Vibration is not supported on this browser/device (e.g. iOS Safari).';
  } else {
    els.vibeTest.addEventListener('click', () => {
      testVibration();
      els.vibeStatus.textContent = 'Buzzing now — feel that?';
    });
  }

  // --- Webhook settings ---------------------------------------------------

  const savedWhUrl = localStorage.getItem('aura.webhookUrl');
  if (savedWhUrl !== null) els.webhookUrl.value = savedWhUrl;
  const savedWhMethod = localStorage.getItem('aura.webhookMethod');
  if (savedWhMethod !== null) els.webhookMethod.value = savedWhMethod;
  const savedWhHeaders = localStorage.getItem('aura.webhookHeaders');
  if (savedWhHeaders !== null) els.webhookHeaders.value = savedWhHeaders;
  const savedWhAction = localStorage.getItem('aura.webhookAction');
  if (savedWhAction !== null) els.webhookAction.value = savedWhAction;
  const savedWhSchema = localStorage.getItem('aura.webhookSchema');
  if (savedWhSchema !== null) els.webhookSchema.value = savedWhSchema;

  els.webhookUrl.addEventListener('input', () =>
    localStorage.setItem('aura.webhookUrl', els.webhookUrl.value)
  );
  els.webhookMethod.addEventListener('change', () =>
    localStorage.setItem('aura.webhookMethod', els.webhookMethod.value)
  );
  els.webhookHeaders.addEventListener('input', () =>
    localStorage.setItem('aura.webhookHeaders', els.webhookHeaders.value)
  );
  els.webhookAction.addEventListener('input', () =>
    localStorage.setItem('aura.webhookAction', els.webhookAction.value)
  );
  els.webhookSchema.addEventListener('input', () =>
    localStorage.setItem('aura.webhookSchema', els.webhookSchema.value)
  );

  els.webhookTest.addEventListener('click', async () => {
    els.webhookStatus.textContent = 'Sending test…';
    const body = JSON.stringify({ event: 'test', timestamp: new Date().toISOString(), message: 'Aura webhook test.' });
    sendWebhook(body);
    els.webhookStatus.textContent = 'Test sent.';
    setTimeout(() => { if (els.webhookStatus.textContent === 'Test sent.') els.webhookStatus.textContent = ''; }, 3000);
  });
}

// --- Init -----------------------------------------------------------------

setupControls();

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => (els.mode.textContent = h.mode))
  .catch(() => {});
