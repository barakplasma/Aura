import { alert as alertOut, resetFeedback, testVibration, canVibrate } from './feedback.js';
import {
  scanClient,
  fetchModels,
  getExamples, addExample, removeExample, clearExamples,
  getOptimizedArtifact,
  runDetectionOptimization, runActionOptimization,
} from './aura.bundle.js';

const CAPTURE_W = 640;
const CAPTURE_H = 480;
const JPEG_QUALITY = 0.4;

const $ = (id) => document.getElementById(id);

const els = {
  video: $('video'),
  canvas: $('canvas'),
  flash: $('flash'),
  status: $('status'),
  statusDot: $('status-dot'),
  mission: $('mission'),
  action: $('action'),
  toggle: $('toggle'),
  thresholdRange: $('threshold-range'),
  thresholdVal: $('threshold-val'),
  scanRange: $('scan-range'),
  scanVal: $('scan-val'),
  speechToggle: $('speech-toggle'),
  hapticsToggle: $('haptics-toggle'),
  vibeTest: $('vibe-test'),
  vibeStatus: $('vibe-status'),
  rate: $('rate'),
  providerBaseUrl: $('provider-baseurl'),
  providerApiKey: $('provider-apikey'),
  providerModel: $('provider-model'),
  modelSelect: $('model-select'),
  fetchModelsBtn: $('fetch-models-btn'),
  webhookUrl: $('webhook-url'),
  webhookMethod: $('webhook-method'),
  webhookHeaders: $('webhook-headers'),
  webhookAction: $('webhook-action'),
  webhookSchema: $('webhook-schema'),
  webhookTest: $('webhook-test'),
  webhookStatus: $('webhook-status'),
  trainType: $('train-type'),
  trainMission: $('train-mission'),
  trainScene: $('train-scene'),
  trainTriggered: $('train-triggered'),
  trainConfidence: $('train-confidence'),
  trainReason: $('train-reason'),
  trainInstruction: $('train-instruction'),
  trainContext: $('train-context'),
  trainMessage: $('train-message'),
  trainAddBtn: $('train-add-btn'),
  trainExampleList: $('train-example-list'),
  trainApikey: $('train-apikey'),
  trainOptDetection: $('train-opt-detection'),
  trainOptAction: $('train-opt-action'),
  trainStatus: $('train-status'),
  trainClearBtn: $('train-clear-btn'),
  trainDetectionFields: $('train-detection-fields'),
  trainActionFields: $('train-action-fields'),
  latency: $('latency'),
  confidence: $('confidence'),
  mode: $('mode'),
  tokens: $('tokens'),
  cost: $('cost'),
  alertLog: $('alert-log'),
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
      const examples = getExamples();
      const artifact = getOptimizedArtifact();
      const result = await scanClient({
        baseUrl: els.providerBaseUrl.value.trim() || undefined,
        model: getModelName(),
        apiKey: els.providerApiKey.value.trim() || undefined,
        mission: els.mission.value.trim(),
        action: els.action.value.trim(),
        image: captureFrame(),
        threshold: state.threshold,
        webhookAction: whAction || undefined,
        webhookSchema: whSchema || undefined,
        examples: examples.length > 0 ? examples : undefined,
        optimizedInstruction: artifact?.program?.instruction || undefined,
      });
      if (!state.running) return;
      const rtt = Math.round(performance.now() - started);
      els.latency.textContent = String(result.latencyMs ?? rtt);
      els.mode.textContent = result.mode || '—';
      els.statusDot.className = `status-dot ${result.mode === 'live' ? 'live' : result.mode === 'mock' ? 'mock' : 'off'}`;
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

function getModelName() {
  if (els.modelSelect.style.display !== 'none' && els.modelSelect.value) {
    return els.modelSelect.value;
  }
  return els.providerModel.value.trim() || undefined;
}

function handleResult(result) {
  if (result.triggered) {
    els.status.textContent = `⚠ ALERT — ${result.message || result.reason}`;
    flashAlert();
    logAlert(result.message || result.reason, result.confidence);
    alertOut(result.message || result.reason, {
      speech: els.speechToggle.selected,
      haptics: els.hapticsToggle.selected,
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
  const rate = parseFloat(els.rate.value);
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
  els.toggle.innerHTML = '<md-icon slot="icon">stop</md-icon> Stop Monitoring';
  els.toggle.setAttribute('aria-pressed', 'true');
  els.toggle.style.setProperty('--md-filled-button-container-color', 'var(--color-danger)');
  els.status.textContent = 'Monitoring…';
  resetFeedback();
  tick();
}

function stop() {
  state.running = false;
  clearTimeout(state.loopTimer);
  stopCamera();
  resetFeedback();
  els.toggle.innerHTML = '<md-icon slot="icon">play_arrow</md-icon> Start Monitoring';
  els.toggle.setAttribute('aria-pressed', 'false');
  els.toggle.style.removeProperty('--md-filled-button-container-color');
  els.status.textContent = 'Stopped.';
  els.statusDot.className = 'status-dot off';
}

els.toggle.addEventListener('click', () => (state.running ? stop() : start()));

// --- Provider model fetching ----------------------------------------------

async function handleFetchModels() {
  const baseUrl = els.providerBaseUrl.value.trim();
  const apiKey = els.providerApiKey.value.trim();
  if (!baseUrl) { els.status.textContent = 'Enter a Base URL first.'; return; }
  if (!apiKey) { els.status.textContent = 'Enter an API key first.'; return; }

  els.fetchModelsBtn.innerHTML = 'Fetching…';
  els.fetchModelsBtn.disabled = true;
  try {
    const models = await fetchModels(baseUrl, apiKey);
    if (!state.running) {
      populateModelSelect(models);
      els.modelSelect.style.display = 'block';
      const current = els.providerModel.value.trim();
      if (current && models.includes(current)) {
        els.modelSelect.value = current;
      } else if (models.length > 0) {
        els.modelSelect.value = models[0];
      }
      els.status.textContent = `Found ${models.length} models.`;
    }
  } catch (err) {
    els.status.textContent = `Fetch failed: ${err.message}. You can type a model name manually.`;
    els.modelSelect.style.display = 'none';
  } finally {
    els.fetchModelsBtn.innerHTML = 'Fetch Models';
    els.fetchModelsBtn.disabled = false;
  }
}

function populateModelSelect(models) {
  els.modelSelect.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('md-select-option');
    opt.value = m;
    opt.textContent = m;
    els.modelSelect.appendChild(opt);
  }
}

els.fetchModelsBtn.addEventListener('click', handleFetchModels);

// When model text field changes, hide the select if user is typing manually
els.providerModel.addEventListener('input', () => {
  if (els.providerModel.value.trim()) {
    els.modelSelect.style.display = 'none';
  }
});

// --- Settings -------------------------------------------------------------

function setupControls() {
  const savedBaseUrl = localStorage.getItem('aura.baseUrl');
  if (savedBaseUrl !== null) els.providerBaseUrl.value = savedBaseUrl;
  const savedApiKey = localStorage.getItem('aura.apiKey');
  if (savedApiKey !== null) els.providerApiKey.value = savedApiKey;
  const savedModel = localStorage.getItem('aura.model');
  if (savedModel !== null) els.providerModel.value = savedModel;

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

  // Provider persistence
  els.providerBaseUrl.addEventListener('input', () =>
    localStorage.setItem('aura.baseUrl', els.providerBaseUrl.value)
  );
  els.providerApiKey.addEventListener('input', () =>
    localStorage.setItem('aura.apiKey', els.providerApiKey.value)
  );
  els.providerModel.addEventListener('input', () =>
    localStorage.setItem('aura.model', els.providerModel.value)
  );

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
    els.hapticsToggle.selected = false;
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

  // --- Training / examples ------------------------------------------------

  els.trainType.addEventListener('change', () => {
    const isDetection = els.trainType.value === 'detection';
    els.trainDetectionFields.hidden = !isDetection;
    els.trainActionFields.hidden = isDetection;
  });

  function readTrainForm() {
    if (els.trainType.value === 'detection') {
      return {
        type: 'detection',
        mission: els.trainMission.value.trim(),
        sceneDescription: els.trainScene.value.trim(),
        triggered: els.trainTriggered.selected,
        confidence: parseInt(els.trainConfidence.value, 10) || 0,
        reason: els.trainReason.value.trim(),
      };
    }
    return {
      type: 'action',
      instruction: els.trainInstruction.value.trim(),
      context: els.trainContext.value.trim(),
      message: els.trainMessage.value.trim(),
    };
  }

  function clearTrainForm() {
    els.trainMission.value = '';
    els.trainScene.value = '';
    els.trainTriggered.selected = false;
    els.trainConfidence.value = '80';
    els.trainReason.value = '';
    els.trainInstruction.value = '';
    els.trainContext.value = '';
    els.trainMessage.value = '';
  }

  function renderExamples() {
    const examples = getExamples();
    els.trainExampleList.innerHTML = '';
    for (const ex of examples) {
      const li = document.createElement('li');
      li.className = 'train-example-item';
      let label;
      if (ex.type === 'detection') {
        label = `detection: "${(ex.mission || '').slice(0, 40)}" → ${ex.triggered ? 'true' : 'false'}/${ex.confidence}`;
      } else {
        label = `action: "${(ex.instruction || '').slice(0, 40)}"`;
      }
      li.textContent = label;
      const del = document.createElement('button');
      del.textContent = '×';
      del.className = 'train-del-btn';
      del.addEventListener('click', () => { removeExample(ex.id); renderExamples(); });
      li.appendChild(del);
      els.trainExampleList.appendChild(li);
    }
  }

  els.trainAddBtn.addEventListener('click', () => {
    const ex = readTrainForm();
    if (ex.type === 'detection' && !ex.mission) { els.trainStatus.textContent = 'Mission is required.'; return; }
    if (ex.type === 'action' && !ex.instruction) { els.trainStatus.textContent = 'Instruction is required.'; return; }
    addExample(ex);
    clearTrainForm();
    renderExamples();
    els.trainStatus.textContent = 'Example added.';
    setTimeout(() => { if (els.trainStatus.textContent === 'Example added.') els.trainStatus.textContent = ''; }, 2000);
  });

  els.trainClearBtn.addEventListener('click', () => {
    clearExamples();
    renderExamples();
    els.trainStatus.textContent = 'All examples cleared.';
  });

  async function runOptimization(type) {
    const apiKey = els.trainApikey.value.trim();
    if (!apiKey) { els.trainStatus.textContent = 'Enter a Cerebras API key for optimization.'; return; }
    const examples = getExamples().filter((ex) => ex.type === type);
    if (examples.length < 2) { els.trainStatus.textContent = `Need at least 2 ${type} examples.`; return; }

    els.trainStatus.textContent = `Optimizing ${type}… this may take a minute.`;
    els.trainOptDetection.disabled = true;
    els.trainOptAction.disabled = true;

    try {
      const fn = type === 'detection' ? runDetectionOptimization : runActionOptimization;
      const result = await fn({
        apiKey,
        examples,
      });
      els.trainStatus.textContent = `${type} optimization done! Best score: ${result.bestScore?.toFixed(2) || '?'}`;
    } catch (err) {
      els.trainStatus.textContent = `Optimization failed: ${err.message}`;
    } finally {
      els.trainOptDetection.disabled = false;
      els.trainOptAction.disabled = false;
    }
  }

  els.trainOptDetection.addEventListener('click', () => runOptimization('detection'));
  els.trainOptAction.addEventListener('click', () => runOptimization('action'));

  renderExamples();
}

// --- Init -----------------------------------------------------------------

setupControls();
