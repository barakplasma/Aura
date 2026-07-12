import { useState, useRef, useCallback, useEffect } from "react";
import { scanClient } from "../../lib/aura.js";
import { demoScan } from "../../lib/demo.js";
import {
  getExamples,
  getOptimizedArtifact,
  addExample,
} from "../../lib/training-store.js";
import { recordLatency, percentile, tunedTimeoutMs } from "../../lib/stats.js";
import { computeGapMs, emaUpdate } from "../../lib/scheduler.js";
import { alert as alertOut, resetFeedback } from "../../public/feedback.js";

const CAPTURE_W = 640;
const CAPTURE_H = 480;
const JPEG_QUALITY = 0.4;

// Self-tuning timeout never dips below this, so ordinary latency variance
// doesn't kill a scan mid-flight. There is no operator-set ceiling — beyond
// the floor, the bound is derived entirely from this session's own latency
// history (mean + 3 stddev, once enough samples have landed).
const TIMEOUT_FLOOR_MS = 4000;
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

const IDLE_PROGRESS = {
  phase: "idle",
  pct: null,
  etaMs: null,
  estimateMs: null,
};
const EMPTY_STATS = { p50: null, p90: null, timeoutMs: null, count: 0 };

export function useMonitor({ settingsRef, videoRef, canvasRef }) {
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
  });
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
  });
  const ctxRef = useRef(null);

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
    const time = new Date().toLocaleTimeString();
    const conf = Number.isFinite(confidence) ? Math.round(confidence) : null;
    setAlerts((prev) => {
      const next = [
        {
          id: Date.now(),
          time,
          conf,
          message,
          reason: reason || "",
          image: image || null,
        },
        ...prev,
      ];
      return next.slice(0, 20);
    });
  }, []);

  // Keep a handful of recent non-alert frames, spaced out in time, so the
  // operator can spot a miss and mark it a false negative. Frames are only
  // available in live mode (demo has no camera capture).
  const recordMissed = useCallback((image, reason, confidence) => {
    if (!image) return;
    const now = performance.now();
    if (now - internalRef.current.lastMissedAt < MISSED_SPACING_MS) return;
    internalRef.current.lastMissedAt = now;
    const time = new Date().toLocaleTimeString();
    const conf = Number.isFinite(confidence) ? Math.round(confidence) : null;
    setMissed((prev) =>
      [
        { id: Date.now(), time, reason: reason || "", conf, image },
        ...prev,
      ].slice(0, MISSED_MAX),
    );
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
      fetch(url, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : body,
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
    if (!internalRef.current.inFlight && ready) {
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
      const effTimeoutMs = isMaxMode
        ? null
        : tunedTimeoutMs(st.samples, {
            floorMs: TIMEOUT_FLOOR_MS,
            minSamples: TIMEOUT_MIN_SAMPLES,
          });
      try {
        // Read training data once per scan (not per render — parsing
        // localStorage on the render path was wasted work).
        const examples = getExamples();
        const optimizedInstruction =
          getOptimizedArtifact()?.program?.instruction;
        const result = s.demo
          ? demoScan({
              mission: s.mission,
              action: s.action,
              threshold: s.threshold ?? 0,
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
        st.samples = recordLatency(st.samples, measured);
        const p50 = percentile(st.samples, 50);
        const p90 = percentile(st.samples, 90);
        const timeoutMs = isMaxMode
          ? Infinity
          : tunedTimeoutMs(st.samples, {
              floorMs: TIMEOUT_FLOOR_MS,
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
    if (internalRef.current.stream) {
      internalRef.current.stream.getTracks().forEach((t) => t.stop());
      internalRef.current.stream = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    resetFeedback();
    setRunning(false);
    setStatus("Stopped.");
    setDotClass("off");
    setProgress(IDLE_PROGRESS);
  }, [videoRef]);

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
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }, [settingsRef, stop]);

  const start = useCallback(async () => {
    const s = settingsRef.current;
    if (!s.demo && !s.apiKey) {
      setStatus("No API key — add one in Settings, or use Demo Mode.");
      return;
    }
    if (!s.demo && !s.mission.trim()) {
      setStatus("Describe the mission (what to watch for) first.");
      return;
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
      if (internalRef.current.stream) {
        internalRef.current.stream.getTracks().forEach((t) => t.stop());
        internalRef.current.stream = null;
      }
      if (videoRef.current) videoRef.current.srcObject = null;
      // Demo doesn't capture frames, so run without a preview.
      if (!s.demo) {
        setStatus(
          `${s.videoSource === "screen" ? "Screen share" : "Camera"} unavailable: ${err.message}`,
        );
        return;
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
    start,
    stop,
    switchCamera,
    sendWebhook,
  };
}
