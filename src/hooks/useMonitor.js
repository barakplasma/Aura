import { useState, useRef, useCallback, useEffect } from "react";
import { scanClient, isLocalBaseUrl } from "../../lib/aura.js";
import { demoScan } from "../../lib/demo.js";
import {
  scanBrowser,
  BROWSER_MODELS,
  detectObjects,
  detectorDeviceName,
  isBrowserModelLoaded,
  unloadBrowserModel,
} from "../../lib/browser-engine.js";
import { GATE_WIDTH, GATE_HEIGHT, toGray, motionPreset } from "../../lib/motion.js";
import { decodeDetections, gateOpts } from "../../lib/object-gate.js";
import {
  createGateState,
  beginTick,
  afterMotion,
  afterDetect,
  detectFailed,
  defer,
  scanCompleted,
  seedFrom,
} from "../../lib/gate-session.js";
import {
  DEFAULT_DETECTOR_MODEL,
  parseClassFilter,
} from "../../lib/detector-models.js";
import {
  getExamples,
  getOptimizedArtifact,
  addExample,
} from "../../lib/training-store.js";
import { recordLatency, percentile, tunedTimeoutMs } from "../../lib/stats.js";
import { computeGapMs, emaUpdate } from "../../lib/scheduler.js";
import { costForUsage } from "../../lib/pricing.js";
import {
  shouldCatchUp,
  nextReconnectDelayMs,
  RECONNECT_ATTEMPTS,
} from "../../lib/keepalive.js";
import { createAlertStore } from "../../lib/alert-store.js";
import { alert as alertOut, resetFeedback } from "../../public/feedback.js";
import { useWakeLock } from "./useWakeLock.js";
import { normalizeCaptureSize } from "../../lib/frame.js";
import { focusConstraint } from "../../lib/camera-focus.js";
import { processingProgress } from "../../lib/progress.js";
import { reportUnexpectedError } from "../../lib/handled-errors.js";
import { encodeNtfyHeader, isHostedNtfyTopicUrl } from "../../lib/ntfy.js";
import { reportHandledError } from "../monitoring.js";

// One store per page load — its IndexedDB adapter is lazy (never touches the
// indexedDB global until an operation runs), so creating it here is safe even
// before a monitoring session ever starts.
const alertStore = createAlertStore();

const JPEG_QUALITY = 0.4;

// Self-tuning timeout never dips below this, so ordinary latency variance
// doesn't kill a scan mid-flight. There is no operator-set ceiling — beyond
// the floor, the bound is derived entirely from this session's own latency
// history (mean + 3 stddev, once enough samples have landed). The BROWSER
// engine needs a much higher floor: a phone doing WebGPU (or WASM-fallback)
// inference can take many seconds, especially on the first scan while the
// model is still warming up.
const TIMEOUT_FLOOR_MS_PROVIDER = 4000;
const TIMEOUT_FLOOR_MS_BROWSER = 30000;
const TIMEOUT_MIN_SAMPLES = 5;
// How many recent non-alert frames to keep for false-negative review, and how
// far apart to sample them (they're near-duplicates otherwise).
const MISSED_MAX = 4;
const MISSED_SPACING_MS = 15000;
// Fixed per-request prompt/overhead added to the measured JPEG payload when
// estimating request bytes for the network budget cap.
const PROMPT_OVERHEAD_BYTES = 1500;
// Progress ticker cadence — drives the countdown + fill smoothly without
// re-rendering the tree on every animation frame.
const PROGRESS_INTERVAL_MS = 250;
// A track muted this long while the page is visible is treated the same as
// "ended" — some Android builds mute the track instead of ending it when the
// OS reclaims the camera.
const VISIBLE_MUTE_TIMEOUT_MS = 10000;
// Reconnect attempts before giving up and stopping (see nextReconnectDelayMs).
const MAX_RECONNECT_ATTEMPTS = 3;
// Object gate (docs/PRD-object-gate.md): how often the cascade checks when no
// cadence is otherwise due, and the floor/ceiling an operator's value is
// clamped to. 2s rather than 1s because a 640² detector at 1 Hz is a real, if
// modest, continuous load on a phone — and 4s worst-case detection latency is
// well inside what a doorway monitor needs.
const GATE_INTERVAL_DEFAULT_MS = 2000;
const GATE_INTERVAL_MIN_MS = 500;
const GATE_INTERVAL_MAX_MS = 60000;

const IDLE_PROGRESS = {
  phase: "idle",
  pct: null,
  etaMs: null,
  estimateMs: null,
};
const EMPTY_STATS = { p50: null, p90: null, timeoutMs: null, count: 0 };

// Gate tick cadence in ms, or null when the gate is off for this session.
// Clamped rather than validated: this reads a free-text number field, and a
// stray 0 must not turn the loop into a spin.
function gateIntervalMs(s) {
  if (!s.objectGate || s.demo) return null;
  const secs = Number(s.objectGateEveryS);
  const ms = Number.isFinite(secs) && secs > 0 ? secs * 1000 : GATE_INTERVAL_DEFAULT_MS;
  return Math.min(GATE_INTERVAL_MAX_MS, Math.max(GATE_INTERVAL_MIN_MS, ms));
}

// The operator's MOVEMENT THRESHOLD, when they set one — an out-of-range or
// unparseable value falls back to the preset rather than disabling movement
// detection silently.
function moveFracOverride(s) {
  const v = Number(s.objectMoveFrac);
  return Number.isFinite(v) && v > 0 && v <= 1 ? { moveFrac: v } : {};
}

function sendJsonWebhook(url, method, headers, body) {
  fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    signal: AbortSignal.timeout(5000),
    mode: "no-cors",
  }).catch(() => {});
}

function notificationText(body) {
  if (typeof body !== "string") return "Aura alert";
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.message === "string" ? parsed.message : body;
  } catch {
    return body;
  }
}

async function sendNtfyImage(url, body, headers, frame) {
  const image = await fetch(frame).then((response) => response.blob());
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": image.type || "image/jpeg",
      "X-Filename": `aura-alert-${stamp}.jpg`,
      "X-Message": encodeNtfyHeader(notificationText(body)),
      "X-Title": "Aura alert",
      "X-Priority": "4",
      "X-Tags": "warning,camera",
    },
    body: image,
    signal: AbortSignal.timeout(15000),
    mode: "cors",
  });
  if (!response.ok) throw new Error(`ntfy upload failed: HTTP ${response.status}`);
}

async function sendNtfyText(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "text/plain",
      "X-Message": encodeNtfyHeader(notificationText(body)),
      "X-Title": "Aura alert",
      "X-Priority": "4",
      "X-Tags": "warning,camera",
    },
    body: "",
    signal: AbortSignal.timeout(10000),
    mode: "cors",
  });
  if (!response.ok) throw new Error(`ntfy publish failed: HTTP ${response.status}`);
}

// Shared shape for an alert/missed-frame record: a numeric id (insertion
// order), an ISO timestamp (sortable, used by alert-store), and a locale
// time string (what the UI displays).
function historyRecord(fields) {
  return {
    id: Date.now(),
    at: new Date().toISOString(),
    time: new Date().toLocaleTimeString(),
    ...fields,
  };
}

// Stop any live tracks and detach the preview. Shared by stop() and the
// start() failure path so an acquired-but-unusable stream never stays live.
function releaseStream(internalRef, videoRef) {
  if (internalRef.current.stream) {
    internalRef.current.stream.getTracks().forEach((t) => t.stop());
    internalRef.current.stream = null;
  }
  if (videoRef.current) videoRef.current.srcObject = null;
}

export function useMonitor({ settingsRef, videoRef, canvasRef, demoMode, keepScreenOn }) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Configure a provider and press Start.");
  const [dotClass, setDotClass] = useState("off");
  const [flashActive, setFlashActive] = useState(false);
  const [telemetry, setTelemetry] = useState({
    latency: "—",
    confidence: "—",
    mode: "—",
    tokens: "0",
    frameTokens: "—",
    frameDetails: "—",
    cost: "0.0000",
    scansPerHr: "—",
    costPerHr: "0.0000",
    skipped: 0,
    objects: "—",
    gate: "—",
    detect: "—",
    gateSkipped: 0,
  });
  // Holds a screen wake lock while actually armed and live (demo mode has no
  // camera to protect, and an operator can opt out via aura.keepScreenOn).
  const { held: wakeLockHeld, hint: wakeLockHint } = useWakeLock(
    running && !demoMode && keepScreenOn,
  );
  const [alerts, setAlerts] = useState([]);
  const [missed, setMissed] = useState([]);
  const [progress, setProgress] = useState(IDLE_PROGRESS);
  const [stats, setStats] = useState(EMPTY_STATS);
  const [markedIds, setMarkedIds] = useState({});

  const internalRef = useRef({
    stream: null,
    inFlight: false,
    loopTimer: null,
    totalTokens: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    running: false,
    abort: null,
    // latency samples + current scan-cycle phase, read by the progress ticker.
    samples: [],
    phase: "idle",
    stage: "",
    phaseStart: 0,
    phaseEstimate: 0,
    progressTimer: null,
    lastMissedAt: 0,
    switching: false,
    // Per-session EMAs (α = 0.3) that feed the budget scheduler.
    emaPromptTokens: null,
    emaCompletionTokens: null,
    emaBytes: null,
    emaDuration: null,
    budgetWarned: false,
    // Keepalive: when the last scan completed (for the visibility catch-up
    // check), the gap it was scheduled with, and the current camera track's
    // mute/reconnect state.
    lastScanAt: null,
    lastGapMs: 0,
    trackMuted: false,
    mutedSince: 0,
    reconnecting: false,
    // Object gate: the tracked inventory, the motion reference, and the
    // bookkeeping that decides whether the VLM runs at all this tick.
    // Every decision lives in lib/gate-session.js; the hook only owns the
    // camera-side plumbing (the stage 0 canvas and its reusable buffer),
    // the detector latency EMA, and the hint riding along with a scan.
    gate: createGateState(),
    grayBuf: null,
    detectEma: null,
    gateWarned: false,
    gateHint: "",
  });
  const ctxRef = useRef(null);
  // acquireStream/reconnect are mutually recursive (a track's onended handler
  // starts a reconnect loop that itself calls acquireStream) — a ref avoids
  // an import-order/useCallback ordering problem between the two.
  const reconnectRef = useRef(null);

  // Hydrate alert/missed/mark history from IndexedDB on mount, so a reload
  // doesn't wipe out an armed session's history. Runs once; a failed read
  // just leaves the screen empty rather than blocking the app.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [alertsList, missedList, marks] = await Promise.all([
          alertStore.listAlerts(),
          alertStore.listMissed(),
          alertStore.listMarks(),
        ]);
        if (cancelled) return;
        if (alertsList.length) setAlerts(alertsList.slice(0, 20));
        if (missedList.length) setMissed(missedList.slice(0, MISSED_MAX));
        if (Object.keys(marks).length) setMarkedIds(marks);
      } catch (err) {
        console.warn("[aura] failed to load alert history", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const captureFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const { width, height } = normalizeCaptureSize(
      settingsRef.current.captureSize,
    );
    canvas.width = width;
    canvas.height = height;
    // Cache the 2D context; no willReadFrequently — we only draw and encode,
    // never read pixels back, so the GPU-backed canvas is the fast path.
    if (!ctxRef.current || ctxRef.current.canvas !== canvas) {
      ctxRef.current = canvas.getContext("2d");
    }
    const ctx = ctxRef.current;
    if (settingsRef.current.videoSource === "screen") {
      // Screen shares are arbitrary aspect ratios — letterbox (aspect-fit) so
      // the model sees an undistorted frame rather than a stretched desktop.
      const vw = video.videoWidth || width;
      const vh = video.videoHeight || height;
      const scale = Math.min(width / vw, height / vh);
      const dw = vw * scale,
        dh = vh * scale;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
    } else {
      // Camera path keeps the existing fill-the-canvas stretch draw.
      ctx.drawImage(video, 0, 0, width, height);
    }
    const image = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    internalRef.current.frameDetails = {
      width,
      height,
      sourceWidth: video.videoWidth || width,
      sourceHeight: video.videoHeight || height,
      bytes: Math.round((image.length - image.indexOf(",") - 1) * 0.75),
    };
    return image;
  }, [canvasRef, videoRef, settingsRef]);

  // --- Object gate ---------------------------------------------------------
  // Three stages, each far cheaper than the next (docs/PRD-object-gate.md):
  // a 64x48 pixel diff, then a YOLO26 pass, then — only if the set of objects
  // actually changed — the vision-language model. The gate never raises an
  // alert; it only decides whether the expensive call happens.

  // Anything in here invalidates the tracked inventory: a different camera,
  // a different mission, a different watch list all mean "what counts as
  // normal" has changed, so the gate re-baselines rather than diffing against
  // a scene that no longer exists.
  const baselineSignature = useCallback(
    (s) =>
      [
        s.mission,
        s.objectClasses,
        s.objectModel,
        s.engine,
        s.browserModel,
        s.videoSource,
        s.cameraDeviceId,
        s.cameraFacing,
      ].join("|"),
    [],
  );

  // Stage 0's frame grab. A dedicated tiny canvas with willReadFrequently —
  // never the GPU-backed capture canvas, whose whole point is that nothing
  // reads pixels back from it.
  const grabGray = useCallback((video) => {
    const st = internalRef.current;
    if (!video || video.readyState < 2) return null;
    if (!st.gateCanvas) {
      st.gateCanvas = document.createElement("canvas");
      st.gateCanvas.width = GATE_WIDTH;
      st.gateCanvas.height = GATE_HEIGHT;
      st.gateCtx = st.gateCanvas.getContext("2d", { willReadFrequently: true });
    }
    st.gateCtx.drawImage(video, 0, 0, GATE_WIDTH, GATE_HEIGHT);
    const { data } = st.gateCtx.getImageData(0, 0, GATE_WIDTH, GATE_HEIGHT);
    st.grayBuf = toGray(data, st.grayBuf);
    // toGray writes into the reused buffer, so the reference frame has to be
    // its own copy or it would track the live frame and never diff.
    return Uint8ClampedArray.from(st.grayBuf);
  }, []);

  // One detector pass over the current video frame. The ImageBitmap is
  // transferred to the worker (and closed there), so this allocates nothing
  // that outlives the call.
  const detectFrame = useCallback(async (video, s) => {
    const bitmap = await createImageBitmap(video);
    const { logits, boxes, dims, latencyMs } = await detectObjects(bitmap, {
      model: s.objectModel || DEFAULT_DETECTOR_MODEL,
    });
    const st = internalRef.current;
    st.detectEma = emaUpdate(st.detectEma, latencyMs);
    const opts = gateOpts(s.objectSens || "medium", moveFracOverride(s));
    return {
      opts,
      detections: decodeDetections(logits, boxes, dims, {
        // Decode at the *exit* threshold, not the enter one: those weaker
        // detections exist to keep an already-present track alive, and
        // stepTracks() is what refuses to open a new track below enterScore.
        minScore: opts.exitScore,
        classFilter: parseClassFilter(s.objectClasses),
      }),
    };
  }, []);

  // Seed the inventory from the frame the baseline scan just judged, so
  // everything already in shot enters as `present` and never emits `added`.
  // Failure here is harmless: the seed flag stays set and the next gate tick
  // does the same job, one interval later.
  const seedFromFrame = useCallback(
    async (video, s) => {
      const st = internalRef.current;
      try {
        const { detections } = await detectFrame(video, s);
        if (!internalRef.current.running) return;
        seedFrom(st.gate, detections);
      } catch {
        // Leave the seed pending — the next detector pass does the same job.
      }
    },
    [detectFrame],
  );

  // Drop the VLM out of VRAM once it has been idle long enough. Only the
  // BROWSER engine holds weights locally, and only a gated session is idle
  // long enough for this to be worth doing. The weights stay in the Cache API,
  // so waking it costs session creation (~1-3s), not a download — which is the
  // trade this setting exists to let an operator refuse.
  const maybeEvictIdleModel = useCallback((s) => {
    const st = internalRef.current;
    const mins = Number(s.vlmIdleEvictMin);
    if (!Number.isFinite(mins) || mins <= 0) return;
    if (s.engine !== "browser" || s.demo) return;
    if (st.gate.lastScanAt == null) return;
    if (Date.now() - st.gate.lastScanAt < mins * 60000) return;
    if (!isBrowserModelLoaded(s.browserModel)) return;
    st.evicting = true;
    unloadBrowserModel()
      .catch((err) => console.warn("[aura] idle model eviction failed", err))
      .finally(() => {
        st.evicting = false;
      });
  }, []);

  // Runs the cascade for one tick and returns { pass, why, hint }. Every rule
  // is in lib/gate-session.js; this only fetches what each step asks for — a
  // 64x48 frame for stage 0, a detector pass for stage 1 — in the order it
  // asks for them.
  const runGate = useCallback(
    async (video, s) => {
      const st = internalRef.current;
      const g = st.gate;
      const heartbeatMin = Number(s.heartbeatMin);
      const begin = beginTick(g, {
        now: Date.now(),
        signature: baselineSignature(s),
        heartbeatMs:
          Number.isFinite(heartbeatMin) && heartbeatMin > 0 ? heartbeatMin * 60000 : 0,
      });
      if (begin.decided) return begin;

      const motion = afterMotion(g, {
        gray: grabGray(video),
        preset: motionPreset(s.objectSens || "medium"),
        heartbeatDue: begin.heartbeatDue,
      });
      if (motion.decided) return motion;

      try {
        const { opts, detections } = await detectFrame(video, s);
        if (!internalRef.current.running) return { pass: false, why: "", hint: "" };
        return afterDetect(g, {
          detections,
          opts,
          wakeOn: s.objectWakeOn ?? "added,removed",
          heartbeatDue: begin.heartbeatDue,
          promptContext: Boolean(s.objectPromptContext),
        });
      } catch (err) {
        // A detector that won't load or run (no network on first use, a
        // refused WebGPU device) degrades to "no gate", never to a monitor
        // that stops scanning — and backs off rather than retrying each tick.
        if (!st.gateWarned) {
          st.gateWarned = true;
          console.warn("[aura] object gate unavailable — scanning without it", err);
        }
        return detectFailed(g, { now: Date.now() });
      }
    },
    [baselineSignature, detectFrame, grabGray],
  );

  const logAlert = useCallback((message, confidence, image, reason) => {
    const conf = Number.isFinite(confidence) ? Math.round(confidence) : null;
    const record = historyRecord({
      conf,
      message,
      reason: reason || "",
      image: image || null,
    });
    setAlerts((prev) => [record, ...prev].slice(0, 20));
    // Fire-and-forget: a failed write must never break the scan loop.
    alertStore
      .addAlert(record)
      .catch((err) => console.warn("[aura] failed to persist alert", err));
  }, []);

  // Keep a handful of recent non-alert frames, spaced out in time, so the
  // operator can spot a miss and mark it a false negative. Frames are only
  // available in live mode (demo has no camera capture).
  const recordMissed = useCallback((image, reason, confidence) => {
    if (!image) return;
    const now = performance.now();
    if (now - internalRef.current.lastMissedAt < MISSED_SPACING_MS) return;
    internalRef.current.lastMissedAt = now;
    const conf = Number.isFinite(confidence) ? Math.round(confidence) : null;
    const record = historyRecord({ reason: reason || "", conf, image });
    setMissed((prev) => [record, ...prev].slice(0, MISSED_MAX));
    alertStore
      .addMissed(record)
      .catch((err) => console.warn("[aura] failed to persist missed frame", err));
  }, []);

  // Turn a reviewed frame into a training example. A false positive teaches the
  // detector NOT to fire on that scene; a false negative teaches it to fire.
  const markExample = useCallback((entry, kind) => {
    const triggered = kind === "false-negative";
    addExample({
      type: "detection",
      sceneDescription: entry.reason || entry.message || "",
      triggered,
      confidence: triggered ? 90 : 0,
      reason: triggered
        ? entry.reason || "Operator marked this as a missed alert."
        : "Operator marked this alert as a false positive.",
    });
    setMarkedIds((prev) => ({ ...prev, [entry.id]: kind }));
    alertStore
      .setMark(entry.id, kind)
      .catch((err) => console.warn("[aura] failed to persist mark", err));
  }, []);

  // Wipes both the in-memory history and the store behind it. Called from
  // HistoryScreen's CLEAR HISTORY button, which confirms first.
  const clearHistory = useCallback(() => {
    setAlerts([]);
    setMissed([]);
    setMarkedIds({});
    alertStore
      .clearAll()
      .catch((err) => console.warn("[aura] failed to clear alert history", err));
  }, []);

  const flashAlert = useCallback(() => {
    setFlashActive(true);
    setTimeout(() => setFlashActive(false), 700);
  }, []);

  const parseWebhookSchema = useCallback(() => {
    const raw = (settingsRef.current.webhookSchema || "").trim();
    if (!raw) return null;
    try {
      const s = JSON.parse(raw);
      return s && typeof s === "object" ? s : null;
    } catch {
      return null;
    }
  }, [settingsRef]);

  const sendWebhook = useCallback(
    (body, frame) => {
      const url = (settingsRef.current.webhookUrl || "").trim();
      if (!url) return;
      let headers = { "Content-Type": "application/json" };
      try {
        const custom = JSON.parse(
          (settingsRef.current.webhookHeaders || "").trim() || "{}",
        );
        if (custom && typeof custom === "object")
          headers = { ...headers, ...custom };
      } catch {}
      const method = settingsRef.current.webhookMethod || "POST";
      // webhookMessage is a plain announcement string, not JSON — wrap it so
      // the body matches the application/json Content-Type sent above.
      let formattedBody = body;
      if (typeof body === "string") {
        try {
          JSON.parse(body);
        } catch {
          formattedBody = JSON.stringify({ message: body });
        }
      } else if (body && typeof body === "object") {
        formattedBody = JSON.stringify(body);
      }
      if (
        settingsRef.current.webhookIncludeImage &&
        frame &&
        isHostedNtfyTopicUrl(url)
      ) {
        void sendNtfyImage(url, formattedBody, headers, frame).catch((error) => {
          reportHandledError(error, { area: "ntfy-upload" });
          void sendNtfyText(url, formattedBody, headers).catch((fallbackError) => {
            reportHandledError(fallbackError, { area: "ntfy-fallback" });
          });
        });
        return;
      }
      sendJsonWebhook(url, method, headers, formattedBody);
    },
    [settingsRef],
  );

  // Recompute the progress bar from the current phase on a fixed cadence.
  // "processing" fills toward the median-latency estimate (capped at 95% since
  // it's only an estimate); "waiting" counts down to the next capture.
  const pumpProgress = useCallback(() => {
    const st = internalRef.current;
    if (!st.running) return;
    // A track muted this long while the page is visible is likely a camera
    // the OS reclaimed rather than one merely paused by backgrounding — some
    // Android builds mute instead of firing `ended`. Treat it the same way.
    if (
      st.trackMuted &&
      !st.reconnecting &&
      st.mutedSince &&
      document.visibilityState === "visible" &&
      performance.now() - st.mutedSince > VISIBLE_MUTE_TIMEOUT_MS
    ) {
      reconnectRef.current?.(1);
    }
    const elapsed = performance.now() - st.phaseStart;
    const est = st.phaseEstimate;
    setProgress((prev) => {
      let next;
      if (st.phase === "processing") {
        next = {
          phase: "processing",
          stage: st.stage,
          ...processingProgress(elapsed, est),
        };
      } else if (st.phase === "waiting") {
        const pct =
          est > 0 ? Math.min(100, Math.round((elapsed / est) * 100)) : 100;
        const etaMs = Math.max(0, Math.round((est - elapsed) / 100) * 100);
        next = { phase: "waiting", stage: "waiting", pct, etaMs, estimateMs: est || null, elapsedMs: elapsed, overrun: false };
      } else {
        next = IDLE_PROGRESS;
      }
      // Skip the re-render when nothing the UI shows has changed.
      if (
        prev.phase === next.phase &&
        prev.stage === next.stage &&
        prev.pct === next.pct &&
        prev.etaMs === next.etaMs &&
        prev.overrun === next.overrun
      )
        return prev;
      return next;
    });
  }, []);

  const tick = useCallback(async () => {
    if (!internalRef.current.running) return;
    const video = videoRef.current;
    const s = settingsRef.current;
    // Demo mode simulates scans without a camera frame; live mode needs a
    // decodable video frame before it can capture.
    const ready = s.demo || (video && video.readyState >= 2);
    // Object gate: decide whether this tick is worth a vision-model call at
    // all. Demo mode has no camera to gate, and a muted track is handled
    // below — running a detector over a frozen frame would only waste GPU.
    const gateOn =
      Boolean(s.objectGate) && !s.demo && ready && !internalRef.current.trackMuted;
    let gateSkip = false;
    if (gateOn) {
      const st0 = internalRef.current;
      const decision = await runGate(video, s);
      if (!internalRef.current.running) return;
      // Even a pass waits for the mode's own cadence floor — the gate decides
      // *whether*, the scheduler still decides *how often*. The pending flag
      // is what stops the deferred pass from being forgotten: its events were
      // consumed the tick they were emitted.
      const sinceScan =
        st0.lastScanAt == null ? Infinity : performance.now() - st0.lastScanAt;
      if (decision.pass && sinceScan < st0.lastGapMs) {
        defer(st0.gate, decision);
        gateSkip = true;
      } else if (decision.pass) {
        st0.gateHint = decision.hint || "";
      } else {
        gateSkip = true;
      }
      if (gateSkip) {
        // Idle VRAM eviction: once the VLM only runs a few times an hour,
        // keeping ~800 MB of weights and their KV buffers resident between
        // scans is paying rent on an empty room — and an idle-but-resident
        // GPU allocation is exactly the state the artifacts showed up in. The
        // weights stay in the Cache API, so coming back costs session
        // creation, not a download.
        maybeEvictIdleModel(s);
      }
      setTelemetry((prev) => {
        const objects = st0.gate.objects || "—";
        const gate = decision.why || prev.gate;
        const detect = st0.detectEma
          ? `${Math.round(st0.detectEma)}ms · ${detectorDeviceName() || "?"}`
          : "—";
        if (
          prev.objects === objects &&
          prev.gate === gate &&
          prev.detect === detect &&
          prev.gateSkipped === st0.gate.skips
        )
          return prev;
        return { ...prev, objects, gate, detect, gateSkipped: st0.gate.skips };
      });
    }
    // A muted track (browser paused the camera, usually while hidden) means
    // the frame is a frozen copy of whatever was last visible — skip the AI
    // call rather than burn tokens scoring a still image.
    if (!s.demo && internalRef.current.trackMuted) {
      setTelemetry((prev) => ({ ...prev, skipped: (prev.skipped || 0) + 1 }));
    } else if (!internalRef.current.inFlight && ready && !gateSkip) {
      internalRef.current.inFlight = true;
      const started = performance.now();
      // Enter the processing phase — the bar fills toward the median estimate.
      const st = internalRef.current;
      st.phase = "processing";
      st.stage = "detecting";
      st.phaseStart = started;
      st.phaseEstimate = percentile(st.samples, 50) || 0;
      // One controller per scan so Stop can cancel the request in flight.
      const abort = new AbortController();
      internalRef.current.abort = abort;
      // Capture once, up front, so the exact frame can be attached to an alert
      // (or kept as a false-negative candidate) without re-drawing the canvas.
      const frame = s.demo ? null : captureFrame();
      // The motion reference must become *this* frame once the scan lands —
      // not whatever stage 0 last happened to see (see scanCompleted()).
      const scanGray = gateOn ? grabGray(video) : null;
      // MAX mode never forces a timeout — a scan runs to completion (or is
      // cancelled by Stop) and the next one starts right after, for the
      // highest achievable frame rate. Other modes self-tune the timeout from
      // this session's own latency history (mean + 3 stddev) — no operator
      // ceiling involved.
      const isMaxMode = s.scanMode === "max";
      const isBrowserEngine = s.engine === "browser";
      const timeoutFloorMs = isBrowserEngine
        ? TIMEOUT_FLOOR_MS_BROWSER
        : TIMEOUT_FLOOR_MS_PROVIDER;
      const effTimeoutMs = isMaxMode
        ? null
        : tunedTimeoutMs(st.samples, {
            floorMs: timeoutFloorMs,
            minSamples: TIMEOUT_MIN_SAMPLES,
          });
      try {
        // Read training data once per scan (not per render — parsing
        // localStorage on the render path was wasted work).
        const examples = getExamples();
        const optimizedInstruction =
          getOptimizedArtifact()?.program?.instruction;
        // Model-download progress (first arm, or a model switch) is surfaced
        // as the monitor status so the operator sees "Loading LFM2.5-VL 450M
        // — 61%" instead of a blank screen while the weights fetch.
        const onProgress = isBrowserEngine
          ? (msg) => {
              if (!internalRef.current.running || msg.pct == null) return;
              const label =
                BROWSER_MODELS[s.browserModel]?.label || "browser model";
              setStatus(`Loading ${label} — ${msg.pct}%`);
            }
          : undefined;
        const onStage = (stage) => {
          if (internalRef.current.running) internalRef.current.stage = stage;
        };
        const result = s.demo
          ? demoScan({
              mission: s.mission,
              action: s.action,
              threshold: s.threshold ?? 0,
            })
          : isBrowserEngine
            ? await scanBrowser({
                model: s.browserModel || undefined,
                runtime: s.browserRuntime || undefined,
                mission: s.mission,
                action: s.action,
                image: frame,
                threshold: s.threshold ?? 0,
                webhookAction: s.webhookAction || undefined,
                webhookSchema: parseWebhookSchema() || undefined,
                // Few-shot examples are plain stored data (training-store.js
                // imports no ax) and the json-profile models have the context
                // budget for them. `optimizedInstruction` is deliberately not
                // passed: it is a GEPA artifact tuned against a provider
                // model, and the optimizer screen is hidden on this engine
                // precisely because ax can't drive an in-page model.
                examples,
                sceneHint: internalRef.current.gateHint || undefined,
                signal: abort.signal,
                onProgress,
                onStage,
              })
            : await scanClient({
                baseUrl: s.baseUrl || undefined,
                model: s.model || undefined,
                apiKey: s.apiKey || undefined,
                mission: s.mission,
                action: s.action,
                image: frame,
                threshold: s.threshold ?? 0,
                webhookAction: s.webhookAction || undefined,
                webhookSchema: parseWebhookSchema() || undefined,
                examples: examples.length > 0 ? examples : undefined,
                optimizedInstruction: optimizedInstruction || undefined,
                sceneHint: internalRef.current.gateHint || undefined,
                requestTimeout: effTimeoutMs == null ? null : effTimeoutMs / 1000,
                signal: abort.signal,
                onStage,
              });
        if (!internalRef.current.running) return;
        const rtt = Math.round(performance.now() - started);
        // Record the per-frame latency and refresh the percentile stats.
        const measured = Number.isFinite(result.latencyMs)
          ? result.latencyMs
          : rtt;
        st.lastScanAt = performance.now();
        // Rebase what the gate diffs against onto the frame just judged, and
        // on a cold start seed the inventory from it — so everything already
        // in shot enters as `present` and the couch never emits `added`.
        if (s.objectGate && !s.demo) {
          scanCompleted(st.gate, { now: Date.now(), gray: scanGray });
          st.gateHint = "";
          if (st.gate.seedNext && video) seedFromFrame(video, s);
        }
        st.samples = recordLatency(st.samples, measured);
        const p50 = percentile(st.samples, 50);
        const p90 = percentile(st.samples, 90);
        const timeoutMs = isMaxMode
          ? Infinity
          : tunedTimeoutMs(st.samples, {
              floorMs: timeoutFloorMs,
              minSamples: TIMEOUT_MIN_SAMPLES,
            });
        setStats({ p50, p90, timeoutMs, count: st.samples.length });
        // Feed the budget scheduler's EMAs: input/output tokens (provider usage), the
        // request payload size (base64 JPEG is ~¾ its char length, + prompt
        // overhead), and scan duration. Tokens stay null with no usage data.
        const usageTokens = result.usage?.reported && Number.isFinite(result.usage.total_tokens)
          ? result.usage.total_tokens : null;
        if (result.usage?.reported) {
          st.emaPromptTokens = emaUpdate(st.emaPromptTokens, result.usage.prompt_tokens);
          st.emaCompletionTokens = emaUpdate(st.emaCompletionTokens, result.usage.completion_tokens);
        }
        const frameBytes = frame
          ? frame.length * 0.75 + PROMPT_OVERHEAD_BYTES
          : 0;
        st.emaBytes = emaUpdate(st.emaBytes, frameBytes);
        st.emaDuration = emaUpdate(st.emaDuration, measured);
        setDotClass((prev) => {
          const next =
            result.mode === "live"
              ? "live"
              : result.mode === "demo"
                ? "demo"
                : result.mode === "browser"
                  ? "browser"
                  : "off";
          return prev === next ? prev : next;
        });
        setTelemetry((prev) => {
          const t =
            result.usage?.reported && Number.isFinite(result.usage.total_tokens)
              ? result.usage.total_tokens
              : 0;
          const totalTokens = internalRef.current.totalTokens + t;
          internalRef.current.totalTokens = totalTokens;
          internalRef.current.totalPromptTokens += result.usage?.reported ? result.usage.prompt_tokens : 0;
          internalRef.current.totalCompletionTokens += result.usage?.reported ? result.usage.completion_tokens : 0;
          const cost = costForUsage({
            prompt_tokens: internalRef.current.totalPromptTokens,
            completion_tokens: internalRef.current.totalCompletionTokens,
          }, s.pricing);
          // Spread prev: this update only owns the per-scan fields. Replacing
          // the whole object wiped everything else after every scan — the
          // object gate's rows and the muted-track SKIPPED counter included.
          return {
            ...prev,
            latency: String(result.latencyMs ?? rtt),
            confidence: Number.isFinite(result.confidence)
              ? String(Math.round(result.confidence))
              : "—",
            mode: result.mode || "—",
            tokens: totalTokens.toLocaleString(),
            frameTokens: !result.usage?.reported
              ? "—"
              : `${result.usage.partial ? "≥" : ""}${t.toLocaleString()}`,
            frameDetails: st.frameDetails
              ? `${st.frameDetails.sourceWidth}×${st.frameDetails.sourceHeight} → ${st.frameDetails.width}×${st.frameDetails.height} · ${Math.round(st.frameDetails.bytes / 1024)} KB`
              : "—",
            cost: cost == null ? "—" : cost.toFixed(4),
          };
        });
        if (result.triggered) {
          setStatus(`⚠ ALERT — ${result.message || result.reason}`);
          flashAlert();
          logAlert(
            result.message || result.reason,
            result.confidence,
            frame,
            result.reason,
          );
          alertOut(result.message || result.reason, {
            speech: s.speech,
            haptics: s.haptics,
          });
          // Demo results never carry a webhookMessage, but guard anyway —
          // simulated alerts must never reach a real webhook.
          const ntfyImageAlert =
            s.webhookIncludeImage && isHostedNtfyTopicUrl(s.webhookUrl || "");
          const webhookBody = result.webhookMessage || (
            ntfyImageAlert ? result.message || result.reason : ""
          );
          if (!s.demo && webhookBody) sendWebhook(webhookBody, frame);
        } else {
          setStatus(`Watching — ${result.reason}`);
          recordMissed(frame, result.reason, result.confidence);
        }
        // Budget mode can't cost-cap a provider that returns no token usage —
        // warn once and let the scheduler fall back to interval cadence.
        if (
          s.scanMode === "budget" &&
          usageTokens == null &&
          !st.budgetWarned
        ) {
          st.budgetWarned = true;
          setStatus(
            "Budget mode: provider returns no token usage — using interval cadence. Set a MB/HOUR cap to throttle by data instead.",
          );
        }
      } catch (err) {
        // A Stop mid-scan aborts the request; that's expected, not an error.
        if (internalRef.current.running && reportUnexpectedError(
          err,
          reportHandledError,
          {
            area: "live-monitor",
            engine: isBrowserEngine ? "browser" : "provider",
            inference: isBrowserEngine
              ? "in-browser"
              : isLocalBaseUrl(s.baseUrl) ? "local-provider" : "cloud-provider",
            ...(isBrowserEngine ? {
              model: s.browserModel || "default",
              ...(err.browserContext || {}),
            } : {}),
          },
        )) {
          setStatus(`Error: ${err.message}`);
        }
      } finally {
        internalRef.current.inFlight = false;
        internalRef.current.abort = null;
      }
    }
    if (internalRef.current.running) {
      const st = internalRef.current;
      const s = settingsRef.current;
      // Gap is derived by the scheduler from the mode + per-session EMAs, not
      // by reading scanEvery directly (interval mode still does exactly that).
      const gapMs = computeGapMs(
        s.scanMode || "interval",
        {
          scanEvery: s.scanEvery,
          budgetPerHour: s.budgetPerHour,
          networkMbPerHour: s.networkMbPerHour,
          inputRate: s.pricing?.inputRate,
          outputRate: s.pricing?.outputRate,
        },
        {
          promptTokens: st.emaPromptTokens,
          completionTokens: st.emaCompletionTokens,
          bytes: st.emaBytes,
          durationMs: st.emaDuration,
        },
      );
      // Remembered for the visibilitychange catch-up check — "how far behind
      // is this session, relative to what it was scheduled to do".
      st.lastGapMs = gapMs;
      // Projected throughput/cost from the cycle period (duration + gap).
      const cyclePeriodMs = (st.emaDuration || 0) + gapMs;
      const scansPerHr =
        cyclePeriodMs > 0 ? Math.round(3600e3 / cyclePeriodMs) : 0;
      const scanCost = costForUsage({
        prompt_tokens: st.emaPromptTokens,
        completion_tokens: st.emaCompletionTokens,
      }, s.pricing);
      const costPerHr = (scanCost || 0) * scansPerHr;
      setTelemetry((prev) => {
        const nextScans = String(scansPerHr);
        const nextCost = costPerHr.toFixed(4);
        if (prev.scansPerHr === nextScans && prev.costPerHr === nextCost)
          return prev;
        return { ...prev, scansPerHr: nextScans, costPerHr: nextCost };
      });
      // With the object gate on, the loop runs at the gate's cadence and the
      // scheduler's gap becomes a floor between *scans* rather than the timer
      // itself — checking cheaply every couple of seconds is the entire point.
      // Deliberately not min(gate, gap): in MAX mode the gap is 250 ms, and
      // taking the smaller of the two would run the detector four times a
      // second, which is the GPU load the gate exists to remove.
      const gateMs = gateIntervalMs(s);
      const timerMs = gateMs ?? gapMs;
      // Enter the waiting phase — the bar counts down to the next capture.
      st.phase = "waiting";
      st.stage = "waiting";
      st.phaseStart = performance.now();
      st.phaseEstimate = timerMs;
      internalRef.current.loopTimer = setTimeout(tick, timerMs);
    }
  }, [
    captureFrame,
    flashAlert,
    logAlert,
    maybeEvictIdleModel,
    parseWebhookSchema,
    recordMissed,
    runGate,
    seedFromFrame,
    sendWebhook,
    settingsRef,
    videoRef,
  ]);

  const stop = useCallback(() => {
    internalRef.current.running = false;
    internalRef.current.phase = "idle";
    clearTimeout(internalRef.current.loopTimer);
    clearInterval(internalRef.current.progressTimer);
    if (internalRef.current.abort) internalRef.current.abort.abort();
    clearTimeout(internalRef.current.reconnectTimer);
    releaseStream(internalRef, videoRef);
    resetFeedback();
    setRunning(false);
    setStatus("Stopped.");
    setDotClass("off");
    setProgress(IDLE_PROGRESS);
  }, [videoRef]);

  // Wires mute/unmute/ended handlers onto a freshly acquired camera track, so
  // the scan loop can react to the OS reclaiming the camera or backgrounding
  // pausing it. Screen-share tracks keep their own simpler onended (stop()) —
  // a screen share ending is an intentional "I'm done", not something to
  // reconnect from.
  const attachTrackHandlers = useCallback((stream) => {
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const st = internalRef.current;
    track.onmute = () => {
      st.trackMuted = true;
      st.mutedSince = performance.now();
    };
    track.onunmute = () => {
      st.trackMuted = false;
      st.mutedSince = 0;
    };
    track.onended = () => {
      if (st.running && !st.reconnecting) reconnectRef.current?.(1);
    };
  }, []);

  // Build capture constraints from current settings and acquire a MediaStream.
  // Screen source uses getDisplayMedia (desktop, one gesture per share — its
  // track.onended stops monitoring cleanly); camera source prefers an explicit
  // deviceId when one is chosen, else the facingMode, at the chosen capture size.
  const acquireStream = useCallback(async () => {
    const s = settingsRef.current;
    if (s.videoSource === "screen") {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const track = stream.getVideoTracks()[0];
      if (track) track.onended = () => stop();
      return stream;
    }
    const { width, height } = normalizeCaptureSize(s.captureSize);
    const video = { width: { ideal: width }, height: { ideal: height } };
    if (s.cameraDeviceId) video.deviceId = { exact: s.cameraDeviceId };
    else video.facingMode = { ideal: s.cameraFacing || "environment" };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video,
    });
    // Ask for continuous autofocus before the first frame reaches the model.
    // The driver default on the reference phone left a close subject out of
    // focus, and no prompt or model choice can recover detail the sensor never
    // resolved. A rejection here means a fixed-focus driver, which is exactly
    // the case the capability gate above is meant to fall through.
    const track = stream.getVideoTracks()[0];
    const want = focusConstraint(track?.getCapabilities?.() || {});
    if (track && Object.keys(want).length) {
      try {
        await track.applyConstraints(want);
      } catch {
        // Keep the driver's defaults.
      }
    }
    attachTrackHandlers(stream);
    return stream;
  }, [attachTrackHandlers, settingsRef, stop]);

  // Reconnect loop for a lost/ended camera track: retries acquireStream()
  // with the keepalive backoff (1s, 3s, 8s), then gives up and stop()s with
  // an explanatory status so the operator knows to re-arm by hand.
  const reconnect = useCallback(
    async (attempt = 1) => {
      const st = internalRef.current;
      if (!st.running) return;
      // Each entry invalidates any earlier reconnect attempt: a stale loop's
      // late acquireStream success or scheduled retry must not fight the
      // fresh one (the visibility handler starts attempt 1 while a hidden
      // retry may still be pending).
      const seq = (st.reconnectSeq || 0) + 1;
      st.reconnectSeq = seq;
      clearTimeout(st.reconnectTimer);
      st.reconnecting = true;
      const hidden = document.visibilityState !== "visible";
      // A hidden tab cannot get the camera back no matter how we ask (Android
      // refuses background getUserMedia), so the honest message there is
      // "paused", not "lost" — the session resumes on return to visible.
      setStatus(
        hidden
          ? "Camera paused in background — resumes on return."
          : `Camera lost — reconnecting (${attempt}/${RECONNECT_ATTEMPTS})…`,
      );
      if (st.stream) {
        st.stream.getTracks().forEach((t) => t.stop());
        st.stream = null;
      }
      try {
        const stream = await acquireStream();
        if (st.reconnectSeq !== seq || !internalRef.current.running) {
          // Superseded or disarmed while acquiring — drop what we got.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        st.stream = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        st.trackMuted = false;
        st.mutedSince = 0;
        st.reconnecting = false;
        setStatus("Monitoring…");
      } catch (err) {
        if (st.reconnectSeq !== seq || !internalRef.current.running) return;
        const delay = nextReconnectDelayMs(attempt, hidden);
        if (delay == null) {
          // Visible, ladder exhausted — the operator is looking at the tab
          // and can act on this; giving up silently here is the failure mode.
          st.reconnecting = false;
          stop();
          setStatus(`Camera lost — tap ARM to retry. (${err.message})`);
          return;
        }
        st.reconnectTimer = setTimeout(
          () => reconnectRef.current?.(attempt + 1),
          delay,
        );
      }
    },
    [acquireStream, stop, videoRef],
  );
  // Kept fresh on every render so track.onended / the mute-timeout check
  // (both outside React's render cycle) always call the latest closure.
  reconnectRef.current = reconnect;

  // Returns whether the session actually armed — callers (App.jsx) use this
  // to decide whether to persist aura.armed, so a rejected/misconfigured
  // start() never leaves a phantom RESUME offer for a session that never ran.
  const start = useCallback(async () => {
    const s = settingsRef.current;
    // The API key is deliberately not required — a local server (Ollama, LM
    // Studio, llama.cpp) needs none. Base URL + model are what "configured"
    // means for the PROVIDER engine; the BROWSER engine only needs a model
    // selection (base URL/API key are irrelevant to it).
    const providerReady =
      s.engine === "browser" ? Boolean(s.browserModel) : Boolean(s.baseUrl && s.model);
    if (!s.demo && !providerReady) {
      setStatus(
        s.engine === "browser"
          ? "Pick a BROWSER MODEL in Settings, or use Demo Mode."
          : "Set a provider Base URL and model in Settings, or use Demo Mode.",
      );
      return false;
    }
    if (!s.demo && !s.mission.trim()) {
      setStatus("Describe the mission (what to watch for) first.");
      return false;
    }
    try {
      setStatus(
        s.videoSource === "screen"
          ? "Requesting screen share…"
          : "Starting camera…",
      );
      const stream = await acquireStream();
      internalRef.current.stream = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      // An acquired-but-unusable stream (play() threw, etc.) must not stay
      // live — nothing else will stop it.
      releaseStream(internalRef, videoRef);
      // Demo doesn't capture frames, so run without a preview.
      if (!s.demo) {
        setStatus(
          `${s.videoSource === "screen" ? "Screen share" : "Camera"} unavailable: ${err.message}`,
        );
        return false;
      }
    }
    internalRef.current.running = true;
    internalRef.current.totalTokens = 0;
    internalRef.current.totalPromptTokens = 0;
    internalRef.current.totalCompletionTokens = 0;
    // Fresh latency history each session — a new provider/model has its own
    // performance profile.
    internalRef.current.samples = [];
    internalRef.current.phase = "idle";
    internalRef.current.lastMissedAt = 0;
    // Reset the budget EMAs each session too — cost/size profiles are per-run.
    internalRef.current.emaPromptTokens = null;
    internalRef.current.emaCompletionTokens = null;
    internalRef.current.emaBytes = null;
    internalRef.current.emaDuration = null;
    internalRef.current.budgetWarned = false;
    // Fresh keepalive state each session too.
    internalRef.current.lastScanAt = null;
    internalRef.current.lastGapMs = 0;
    internalRef.current.trackMuted = false;
    internalRef.current.mutedSince = 0;
    internalRef.current.reconnecting = false;
    // Fresh gate state: a new session re-baselines from its first frame rather
    // than diffing against whatever the last one was looking at.
    internalRef.current.gate = createGateState();
    internalRef.current.gateHint = "";
    internalRef.current.detectEma = null;
    internalRef.current.gateWarned = false;
    setTelemetry((prev) => ({
      ...prev,
      skipped: 0,
      objects: "—",
      gate: "—",
      detect: "—",
      gateSkipped: 0,
    }));
    setStats(EMPTY_STATS);
    setProgress(IDLE_PROGRESS);
    setRunning(true);
    setStatus("Monitoring…");
    resetFeedback();
    clearInterval(internalRef.current.progressTimer);
    internalRef.current.progressTimer = setInterval(
      pumpProgress,
      PROGRESS_INTERVAL_MS,
    );
    tick();
    return true;
  }, [acquireStream, pumpProgress, settingsRef, tick, videoRef]);

  // Restart the stream in place (camera flip / source switch) without stopping
  // the scan loop: stop the old tracks, acquire the new stream, reattach.
  const switchCamera = useCallback(async () => {
    const st = internalRef.current;
    if (!st.running || settingsRef.current.demo || st.switching) return;
    // Guard against overlapping calls (rapid taps) racing two acquireStream()
    // promises and leaking whichever stream loses.
    st.switching = true;
    // Release the old camera first — phones can't open the opposite lens
    // while the current one is still held.
    if (st.stream) {
      st.stream.getTracks().forEach((t) => t.stop());
      st.stream = null;
    }
    try {
      const stream = await acquireStream();
      st.stream = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
    } catch (err) {
      // No stream means the scan loop has nothing to capture — shut down
      // cleanly instead of spinning. stop() first so this status wins over
      // its own "Stopped."
      stop();
      setStatus(`Camera switch failed: ${err.message}`);
    } finally {
      st.switching = false;
    }
  }, [acquireStream, settingsRef, stop, videoRef]);

  // Background/visibility handling: a hidden tab still gets throttled ticks
  // from the browser (don't stop scanning outright — a stale scan beats
  // none), but on return, fire an immediate scan when the gap since the last
  // one blew past what was scheduled, instead of waiting out a throttled
  // interval the operator has already come back from.
  useEffect(() => {
    function onVisibility() {
      const st = internalRef.current;
      if (!st.running) return;
      if (document.visibilityState === "visible") {
        // Returning to a visible tab is the one moment Android will grant the
        // camera again, so a reconnect in flight restarts from attempt 1
        // immediately instead of waiting out the hidden-cadence 30s timer.
        // reconnect() invalidates the superseded attempt by sequence.
        if (st.reconnecting) {
          reconnectRef.current?.(1);
          return;
        }
        if (shouldCatchUp(st.lastScanAt, st.lastGapMs, performance.now())) {
          clearTimeout(st.loopTimer);
          tick();
        }
      } else {
        setStatus("Background — scans throttled by the browser.");
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [tick]);

  // On unmount, tear everything down — otherwise the camera track, the scan
  // timeout, and the progress interval keep running in the background.
  useEffect(() => stop, [stop]);

  return {
    running,
    status,
    dotClass,
    flashActive,
    telemetry,
    alerts,
    missed,
    progress,
    stats,
    markedIds,
    markExample,
    clearHistory,
    captureFrame,
    start,
    stop,
    switchCamera,
    sendWebhook,
    wakeLockHeld,
    wakeLockHint,
  };
}
