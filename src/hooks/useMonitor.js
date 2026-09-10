import { useState, useRef, useCallback, useEffect } from "react";
import { scanClient } from "../../lib/aura.js";
import { demoScan } from "../../lib/demo.js";
import { scanBrowser, BROWSER_MODELS } from "../../lib/browser-engine.js";
import {
  getExamples,
  getOptimizedArtifact,
  addExample,
} from "../../lib/training-store.js";
import { recordLatency, percentile, tunedTimeoutMs } from "../../lib/stats.js";
import { computeGapMs, emaUpdate } from "../../lib/scheduler.js";
import { shouldCatchUp, nextReconnectDelayMs } from "../../lib/keepalive.js";
import { createAlertStore } from "../../lib/alert-store.js";
import { alert as alertOut, resetFeedback } from "../../public/feedback.js";
import { useWakeLock } from "./useWakeLock.js";

// One store per page load — its IndexedDB adapter is lazy (never touches the
// indexedDB global until an operation runs), so creating it here is safe even
// before a monitoring session ever starts.
const alertStore = createAlertStore();

const CAPTURE_W = 640;
const CAPTURE_H = 480;
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

const IDLE_PROGRESS = {
  phase: "idle",
  pct: null,
  etaMs: null,
  estimateMs: null,
};
const EMPTY_STATS = { p50: null, p90: null, timeoutMs: null, count: 0 };

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
    cost: "0.0000",
    scansPerHr: "—",
    costPerHr: "0.0000",
    skipped: 0,
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
    running: false,
    abort: null,
    // latency samples + current scan-cycle phase, read by the progress ticker.
    samples: [],
    phase: "idle",
    phaseStart: 0,
    phaseEstimate: 0,
    progressTimer: null,
    lastMissedAt: 0,
    switching: false,
    // Per-session EMAs (α = 0.3) that feed the budget scheduler: tokens/scan,
    // request payload bytes/scan, and scan duration (ms). null until sampled.
    emaTokens: null,
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
    // Cache the 2D context; no willReadFrequently — we only draw and encode,
    // never read pixels back, so the GPU-backed canvas is the fast path.
    if (!ctxRef.current || ctxRef.current.canvas !== canvas) {
      ctxRef.current = canvas.getContext("2d");
    }
    const ctx = ctxRef.current;
    if (settingsRef.current.videoSource === "screen") {
      // Screen shares are arbitrary aspect ratios — letterbox (aspect-fit) so
      // the model sees an undistorted frame rather than a stretched desktop.
      const vw = video.videoWidth || CAPTURE_W;
      const vh = video.videoHeight || CAPTURE_H;
      const scale = Math.min(CAPTURE_W / vw, CAPTURE_H / vh);
      const dw = vw * scale,
        dh = vh * scale;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, CAPTURE_W, CAPTURE_H);
      ctx.drawImage(video, (CAPTURE_W - dw) / 2, (CAPTURE_H - dh) / 2, dw, dh);
    } else {
      // Camera path keeps the existing fill-the-canvas stretch draw.
      ctx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);
    }
    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  }, [canvasRef, videoRef, settingsRef]);

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
    (body) => {
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
      fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : formattedBody,
        signal: AbortSignal.timeout(5000),
        mode: "no-cors",
      }).catch(() => {});
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
        const pct =
          est > 0 ? Math.min(95, Math.round((elapsed / est) * 100)) : null;
        const etaMs =
          est > 0 ? Math.max(0, Math.round((est - elapsed) / 100) * 100) : null;
        next = { phase: "processing", pct, etaMs, estimateMs: est || null };
      } else if (st.phase === "waiting") {
        const pct =
          est > 0 ? Math.min(100, Math.round((elapsed / est) * 100)) : 100;
        const etaMs = Math.max(0, Math.round((est - elapsed) / 100) * 100);
        next = { phase: "waiting", pct, etaMs, estimateMs: est || null };
      } else {
        next = IDLE_PROGRESS;
      }
      // Skip the re-render when nothing the UI shows has changed.
      if (
        prev.phase === next.phase &&
        prev.pct === next.pct &&
        prev.etaMs === next.etaMs
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
    // A muted track (browser paused the camera, usually while hidden) means
    // the frame is a frozen copy of whatever was last visible — skip the AI
    // call rather than burn tokens scoring a still image.
    if (!s.demo && internalRef.current.trackMuted) {
      setTelemetry((prev) => ({ ...prev, skipped: (prev.skipped || 0) + 1 }));
    } else if (!internalRef.current.inFlight && ready) {
      internalRef.current.inFlight = true;
      const started = performance.now();
      // Enter the processing phase — the bar fills toward the median estimate.
      const st = internalRef.current;
      st.phase = "processing";
      st.phaseStart = started;
      st.phaseEstimate = percentile(st.samples, 50) || 0;
      // One controller per scan so Stop can cancel the request in flight.
      const abort = new AbortController();
      internalRef.current.abort = abort;
      // Capture once, up front, so the exact frame can be attached to an alert
      // (or kept as a false-negative candidate) without re-drawing the canvas.
      const frame = s.demo ? null : captureFrame();
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
        // as the monitor status so the operator sees "Loading SmolVLM2 256M —
        // 61%" instead of a blank screen while the weights fetch.
        const onProgress = isBrowserEngine
          ? (msg) => {
              if (!internalRef.current.running || msg.pct == null) return;
              const label =
                BROWSER_MODELS[s.browserModel]?.label || "browser model";
              setStatus(`Loading ${label} — ${msg.pct}%`);
            }
          : undefined;
        const result = s.demo
          ? demoScan({
              mission: s.mission,
              action: s.action,
              threshold: s.threshold ?? 0,
            })
          : isBrowserEngine
            ? await scanBrowser({
                model: s.browserModel || undefined,
                mission: s.mission,
                action: s.action,
                image: frame,
                threshold: s.threshold ?? 0,
                webhookAction: s.webhookAction || undefined,
                webhookSchema: parseWebhookSchema() || undefined,
                signal: abort.signal,
                onProgress,
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
                requestTimeout: effTimeoutMs == null ? null : effTimeoutMs / 1000,
                signal: abort.signal,
              });
        if (!internalRef.current.running) return;
        const rtt = Math.round(performance.now() - started);
        // Record the per-frame latency and refresh the percentile stats.
        const measured = Number.isFinite(result.latencyMs)
          ? result.latencyMs
          : rtt;
        st.lastScanAt = performance.now();
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
        // Feed the budget scheduler's EMAs: tokens/scan (provider usage), the
        // request payload size (base64 JPEG is ~¾ its char length, + prompt
        // overhead), and scan duration. Tokens stay null with no usage data.
        const usageTokens =
          result.usage && Number.isFinite(result.usage.total_tokens)
            ? result.usage.total_tokens
            : null;
        if (usageTokens != null)
          st.emaTokens = emaUpdate(st.emaTokens, usageTokens);
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
            result.usage && Number.isFinite(result.usage.total_tokens)
              ? result.usage.total_tokens
              : 0;
          const totalTokens = internalRef.current.totalTokens + t;
          internalRef.current.totalTokens = totalTokens;
          const rate = parseFloat(s.rate) || 0;
          const cost = ((totalTokens / 1e6) * rate).toFixed(4);
          return {
            latency: String(result.latencyMs ?? rtt),
            confidence: Number.isFinite(result.confidence)
              ? String(Math.round(result.confidence))
              : "—",
            mode: result.mode || "—",
            tokens: totalTokens.toLocaleString(),
            cost,
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
          if (!s.demo && result.webhookMessage)
            sendWebhook(result.webhookMessage);
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
        if (internalRef.current.running && err.name !== "AbortError")
          setStatus(`Error: ${err.message}`);
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
          rate: s.rate,
        },
        {
          tokens: st.emaTokens,
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
      const rate = parseFloat(s.rate) || 0;
      const costPerHr = (((st.emaTokens || 0) * rate) / 1e6) * scansPerHr;
      setTelemetry((prev) => {
        const nextScans = String(scansPerHr);
        const nextCost = costPerHr.toFixed(4);
        if (prev.scansPerHr === nextScans && prev.costPerHr === nextCost)
          return prev;
        return { ...prev, scansPerHr: nextScans, costPerHr: nextCost };
      });
      // Enter the waiting phase — the bar counts down to the next capture.
      st.phase = "waiting";
      st.phaseStart = performance.now();
      st.phaseEstimate = gapMs;
      internalRef.current.loopTimer = setTimeout(tick, gapMs);
    }
  }, [
    captureFrame,
    flashAlert,
    logAlert,
    parseWebhookSchema,
    recordMissed,
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
  // deviceId when one is chosen, else the facingMode, at the 640×480 ideal.
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
    const video = { width: { ideal: CAPTURE_W }, height: { ideal: CAPTURE_H } };
    if (s.cameraDeviceId) video.deviceId = { exact: s.cameraDeviceId };
    else video.facingMode = { ideal: s.cameraFacing || "environment" };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video,
    });
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
      st.reconnecting = true;
      setStatus(
        `Camera lost — reconnecting (${attempt}/${MAX_RECONNECT_ATTEMPTS})…`,
      );
      if (st.stream) {
        st.stream.getTracks().forEach((t) => t.stop());
        st.stream = null;
      }
      try {
        const stream = await acquireStream();
        if (!internalRef.current.running) {
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
        const delay = nextReconnectDelayMs(attempt);
        if (delay == null) {
          st.reconnecting = false;
          stop();
          setStatus(`Camera lost — tap ARM to retry. (${err.message})`);
          return;
        }
        setTimeout(() => reconnectRef.current?.(attempt + 1), delay);
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
    // Fresh latency history each session — a new provider/model has its own
    // performance profile.
    internalRef.current.samples = [];
    internalRef.current.phase = "idle";
    internalRef.current.lastMissedAt = 0;
    // Reset the budget EMAs each session too — cost/size profiles are per-run.
    internalRef.current.emaTokens = null;
    internalRef.current.emaBytes = null;
    internalRef.current.emaDuration = null;
    internalRef.current.budgetWarned = false;
    // Fresh keepalive state each session too.
    internalRef.current.lastScanAt = null;
    internalRef.current.lastGapMs = 0;
    internalRef.current.trackMuted = false;
    internalRef.current.mutedSince = 0;
    internalRef.current.reconnecting = false;
    setTelemetry((prev) => ({ ...prev, skipped: 0 }));
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
