// Aura client — closed-loop spatial guidance in the browser.
//
// Pipeline:
//   getUserMedia -> hidden <canvas> (640x480, JPEG q~0.4)
//     -> POST /api/locate -> { found, x, y, action }
//       -> Web Vibration API + Web Speech API feedback
//
// Real-time discipline: at most one inference request is in flight at a time.
// New frames are dropped while we wait, so we always act on the freshest
// possible result instead of building a backlog.

import {
  drive as driveFeedback,
  resetFeedback,
  testVibration,
  canVibrate,
} from './feedback.js';

const CAPTURE_W = 640;
const CAPTURE_H = 480;
const JPEG_QUALITY = 0.4;
const DEFAULT_FPS = 8; // upload cadence; user-adjustable 1–10
const SLOW_GPU_DELAY_MS = 2000; // artificial latency for the side-by-side demo

const els = {
  video: document.getElementById('video'),
  canvas: document.getElementById('canvas'),
  status: document.getElementById('status'),
  reticle: document.getElementById('reticle'),
  target: document.getElementById('target'),
  toggle: document.getElementById('toggle'),
  mic: document.getElementById('mic'),
  speechToggle: document.getElementById('speech-toggle'),
  hapticsToggle: document.getElementById('haptics-toggle'),
  slowToggle: document.getElementById('slow-toggle'),
  fpsRange: document.getElementById('fps-range'),
  fpsTarget: document.getElementById('fps-target'),
  vibeTest: document.getElementById('vibe-test'),
  vibeStatus: document.getElementById('vibe-status'),
  rate: document.getElementById('rate'),
  latency: document.getElementById('latency'),
  fps: document.getElementById('fps'),
  mode: document.getElementById('mode'),
  tokens: document.getElementById('tokens'),
  cost: document.getElementById('cost'),
};

const ctx = els.canvas.getContext('2d', { willReadFrequently: true });

const state = {
  running: false,
  stream: null,
  inFlight: false,
  loopTimer: null,
  frames: [],
  targetFps: DEFAULT_FPS,
  totalTokens: 0,
};

// --- Camera ---------------------------------------------------------------

async function startCamera() {
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: CAPTURE_W },
      height: { ideal: CAPTURE_H },
    },
  };
  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
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

// Draw the current video frame into the constrained, compressed canvas buffer
// and return a JPEG data URL.
function captureFrame() {
  ctx.drawImage(els.video, 0, 0, CAPTURE_W, CAPTURE_H);
  return els.canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

// --- Inference loop -------------------------------------------------------

async function tick() {
  if (!state.running) return;

  // Frame dropping: never queue a second request behind an in-flight one.
  if (!state.inFlight && els.video.readyState >= 2) {
    state.inFlight = true;
    const image = captureFrame();
    const target = els.target.value.trim();
    const started = performance.now();

    try {
      const slow = els.slowToggle.checked;
      const result = await postLocate(target, image, slow);
      const rtt = Math.round(performance.now() - started);

      recordFrame();
      els.latency.textContent = String(result.latencyMs ?? rtt);
      els.mode.textContent = slow ? 'Slow GPU (sim)' : result.mode || '—';
      recordUsage(result.usage);

      applyResult(result);
    } catch (err) {
      els.status.textContent = `Error: ${err.message}`;
    } finally {
      state.inFlight = false;
    }
  }

  state.loopTimer = setTimeout(tick, 1000 / state.targetFps);
}

// Accumulate token spend and refresh the running cost estimate.
function recordUsage(usage) {
  const t = usage && Number.isFinite(usage.total_tokens) ? usage.total_tokens : 0;
  if (!t) return;
  state.totalTokens += t;
  els.tokens.textContent = state.totalTokens.toLocaleString();
  renderCost();
}

function renderCost() {
  const rate = parseFloat(els.rate.value); // $ per 1M tokens
  const cost = (state.totalTokens / 1e6) * (Number.isFinite(rate) ? rate : 0);
  els.cost.textContent = cost.toFixed(4);
}

async function postLocate(target, image, slow) {
  const resp = await fetch('/api/locate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, image }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  const data = await resp.json();
  // Demo mode: emulate a laggy cloud GPU by withholding the (already computed)
  // result, illustrating why Cerebras' throughput matters for kinetic tasks.
  if (slow) await delay(SLOW_GPU_DELAY_MS);
  return data;
}

function applyResult(result) {
  moveReticle(result);
  els.status.textContent = describe(result, els.target.value.trim());
  driveFeedback(result, {
    speech: els.speechToggle.checked,
    haptics: els.hapticsToggle.checked,
  });
}

function describe(result, target) {
  if (!result.found) return `Searching for ${target || 'target'}…`;
  if (result.action === 'hold_center') return `${target} centered — reach now`;
  const word = {
    steer_left: 'Move left',
    steer_right: 'Move right',
    steer_up: 'Move up',
    steer_down: 'Move down',
  }[result.action];
  return `${word} — ${target}`;
}

function moveReticle(result) {
  if (!result.found) {
    els.reticle.classList.remove('visible', 'centered');
    return;
  }
  els.reticle.classList.add('visible');
  els.reticle.classList.toggle('centered', result.action === 'hold_center');
  els.reticle.style.left = `${result.x}%`;
  els.reticle.style.top = `${result.y}%`;
}

// --- FPS telemetry --------------------------------------------------------

function recordFrame() {
  const now = performance.now();
  state.frames.push(now);
  while (state.frames.length && now - state.frames[0] > 1000) {
    state.frames.shift();
  }
  els.fps.textContent = String(state.frames.length);
}

// --- Lifecycle ------------------------------------------------------------

async function start() {
  const target = els.target.value.trim();
  if (!target) {
    els.status.textContent = 'Please enter a target object first.';
    els.target.focus();
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
  els.toggle.textContent = 'Stop guidance';
  els.toggle.classList.add('active');
  els.toggle.setAttribute('aria-pressed', 'true');
  els.status.textContent = `Scanning for ${target}…`;
  resetFeedback();
  tick();
}

function stop() {
  state.running = false;
  clearTimeout(state.loopTimer);
  stopCamera();
  resetFeedback();
  els.reticle.classList.remove('visible', 'centered');
  els.toggle.textContent = 'Start guidance';
  els.toggle.classList.remove('active');
  els.toggle.setAttribute('aria-pressed', 'false');
  els.status.textContent = 'Stopped.';
  els.fps.textContent = '0';
}

els.toggle.addEventListener('click', () => (state.running ? stop() : start()));

// --- Voice input for target object ---------------------------------------

function setupVoiceInput() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    els.mic.disabled = true;
    els.mic.title = 'Speech recognition not supported on this browser';
    return;
  }
  const recognition = new SR();
  recognition.lang = 'en-US';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  // Drive UI state from the official recognition events rather than the click,
  // so it can't desync if start() throws or the engine stops on its own. A
  // second tap stops/submits early.
  let recording = false;

  els.mic.addEventListener('click', () => {
    if (recording) {
      recognition.stop();
      return;
    }
    try {
      recognition.start();
    } catch {
      /* start() throws if already starting; the start event will sync state */
    }
  });
  recognition.addEventListener('start', () => {
    recording = true;
    els.mic.classList.add('recording');
    els.status.textContent = 'Listening for target…';
  });
  recognition.addEventListener('result', (e) => {
    const said = e.results[0][0].transcript.trim().replace(/[.!?]+$/, '');
    els.target.value = said;
    els.status.textContent = `Target set: ${said}`;
  });
  recognition.addEventListener('end', () => {
    recording = false;
    els.mic.classList.remove('recording');
  });
  recognition.addEventListener('error', () => {
    recording = false;
    els.mic.classList.remove('recording');
    els.status.textContent = 'Could not hear that — please type the target.';
  });
}

// --- Settings: scan rate, cost rate, vibration test ----------------------

function setupControls() {
  // Restore persisted preferences.
  const savedFps = parseInt(localStorage.getItem('aura.fps'), 10);
  if (savedFps >= 1 && savedFps <= 10) {
    state.targetFps = savedFps;
    els.fpsRange.value = String(savedFps);
  }
  els.fpsTarget.textContent = String(state.targetFps);

  const savedRate = localStorage.getItem('aura.rate');
  if (savedRate !== null) els.rate.value = savedRate;

  // Scan-rate slider takes effect immediately (the loop reads state.targetFps).
  els.fpsRange.addEventListener('input', () => {
    state.targetFps = parseInt(els.fpsRange.value, 10) || DEFAULT_FPS;
    els.fpsTarget.textContent = String(state.targetFps);
    localStorage.setItem('aura.fps', String(state.targetFps));
  });

  // Cost-rate input: re-price the running total live.
  els.rate.addEventListener('input', () => {
    localStorage.setItem('aura.rate', els.rate.value);
    renderCost();
  });

  // Vibration self-test + capability messaging.
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
}

// --- Utils ----------------------------------------------------------------

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Init -----------------------------------------------------------------

setupVoiceInput();
setupControls();

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => (els.mode.textContent = h.mode))
  .catch(() => {});
