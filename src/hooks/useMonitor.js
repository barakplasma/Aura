import { useState, useRef, useCallback } from 'react';
import { scanClient } from '../../lib/aura.js';
import { demoScan } from '../../lib/demo.js';
import { getExamples, getOptimizedArtifact } from '../../lib/training-store.js';
import { alert as alertOut, resetFeedback } from '../../public/feedback.js';

const CAPTURE_W = 640;
const CAPTURE_H = 480;
const JPEG_QUALITY = 0.4;

export function useMonitor({ settingsRef, videoRef, canvasRef }) {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Configure a provider and press Start.');
  const [dotClass, setDotClass] = useState('off');
  const [flashActive, setFlashActive] = useState(false);
  const [telemetry, setTelemetry] = useState({ latency: '—', confidence: '—', mode: '—', tokens: '0', cost: '0.0000' });
  const [alerts, setAlerts] = useState([]);

  const internalRef = useRef({ stream: null, inFlight: false, loopTimer: null, totalTokens: 0, running: false, abort: null });
  const ctxRef = useRef(null);

  const captureFrame = useCallback(() => {
    const canvas = canvasRef.current;
    // Cache the 2D context; no willReadFrequently — we only draw and encode,
    // never read pixels back, so the GPU-backed canvas is the fast path.
    if (!ctxRef.current || ctxRef.current.canvas !== canvas) {
      ctxRef.current = canvas.getContext('2d');
    }
    ctxRef.current.drawImage(videoRef.current, 0, 0, CAPTURE_W, CAPTURE_H);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  }, [canvasRef, videoRef]);

  const logAlert = useCallback((message, confidence) => {
    const time = new Date().toLocaleTimeString();
    const conf = Number.isFinite(confidence) ? Math.round(confidence) : null;
    setAlerts(prev => {
      const next = [{ id: Date.now(), time, conf, message }, ...prev];
      return next.slice(0, 20);
    });
  }, []);

  const flashAlert = useCallback(() => {
    setFlashActive(true);
    setTimeout(() => setFlashActive(false), 700);
  }, []);

  const parseWebhookSchema = useCallback(() => {
    const raw = (settingsRef.current.webhookSchema || '').trim();
    if (!raw) return null;
    try {
      const s = JSON.parse(raw);
      return s && typeof s === 'object' ? s : null;
    } catch { return null; }
  }, [settingsRef]);

  const sendWebhook = useCallback((body) => {
    const url = (settingsRef.current.webhookUrl || '').trim();
    if (!url) return;
    let headers = { 'Content-Type': 'application/json' };
    try {
      const custom = JSON.parse((settingsRef.current.webhookHeaders || '').trim() || '{}');
      if (custom && typeof custom === 'object') headers = { ...headers, ...custom };
    } catch {}
    const method = settingsRef.current.webhookMethod || 'POST';
    fetch(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: AbortSignal.timeout(5000),
      mode: 'no-cors',
    }).catch(() => {});
  }, [settingsRef]);

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
      // One controller per scan so Stop can cancel the request in flight.
      const abort = new AbortController();
      internalRef.current.abort = abort;
      try {
        // Read training data once per scan (not per render — parsing
        // localStorage on the render path was wasted work).
        const examples = getExamples();
        const optimizedInstruction = getOptimizedArtifact()?.program?.instruction;
        const result = s.demo
          ? demoScan({ mission: s.mission, action: s.action, threshold: s.threshold ?? 0 })
          : await scanClient({
              baseUrl: s.baseUrl || undefined,
              model: s.model || undefined,
              apiKey: s.apiKey || undefined,
              mission: s.mission,
              action: s.action,
              image: captureFrame(),
              threshold: s.threshold ?? 0,
              webhookAction: s.webhookAction || undefined,
              webhookSchema: parseWebhookSchema() || undefined,
              examples: examples.length > 0 ? examples : undefined,
              optimizedInstruction: optimizedInstruction || undefined,
              requestTimeout: s.requestTimeout,
              signal: abort.signal,
            });
        if (!internalRef.current.running) return;
        const rtt = Math.round(performance.now() - started);
        setDotClass(prev => {
          const next = result.mode === 'live' ? 'live' : result.mode === 'demo' ? 'demo' : 'off';
          return prev === next ? prev : next;
        });
        setTelemetry(prev => {
          const t = result.usage && Number.isFinite(result.usage.total_tokens) ? result.usage.total_tokens : 0;
          const totalTokens = internalRef.current.totalTokens + t;
          internalRef.current.totalTokens = totalTokens;
          const rate = parseFloat(s.rate) || 0;
          const cost = ((totalTokens / 1e6) * rate).toFixed(4);
          return {
            latency: String(result.latencyMs ?? rtt),
            confidence: Number.isFinite(result.confidence) ? String(Math.round(result.confidence)) : '—',
            mode: result.mode || '—',
            tokens: totalTokens.toLocaleString(),
            cost,
          };
        });
        if (result.triggered) {
          setStatus(`⚠ ALERT — ${result.message || result.reason}`);
          flashAlert();
          logAlert(result.message || result.reason, result.confidence);
          alertOut(result.message || result.reason, { speech: s.speech, haptics: s.haptics });
          // Demo results never carry a webhookMessage, but guard anyway —
          // simulated alerts must never reach a real webhook.
          if (!s.demo && result.webhookMessage) sendWebhook(result.webhookMessage);
        } else {
          setStatus(`Watching — ${result.reason}`);
        }
      } catch (err) {
        // A Stop mid-scan aborts the request; that's expected, not an error.
        if (internalRef.current.running && err.name !== 'AbortError') setStatus(`Error: ${err.message}`);
      } finally {
        internalRef.current.inFlight = false;
        internalRef.current.abort = null;
      }
    }
    if (internalRef.current.running) {
      internalRef.current.loopTimer = setTimeout(tick, (parseInt(settingsRef.current.scanEvery, 10) || 5) * 1000);
    }
  }, [captureFrame, flashAlert, logAlert, parseWebhookSchema, sendWebhook, settingsRef, videoRef]);

  const start = useCallback(async () => {
    const s = settingsRef.current;
    if (!s.demo && !s.apiKey) {
      setStatus('No API key — add one in Settings, or use Demo Mode.');
      return;
    }
    if (!s.demo && !s.mission.trim()) {
      setStatus('Describe the mission (what to watch for) first.');
      return;
    }
    try {
      setStatus('Starting camera…');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: CAPTURE_W }, height: { ideal: CAPTURE_H } },
      });
      internalRef.current.stream = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      // Demo doesn't capture frames, so run without a preview.
      if (!s.demo) {
        setStatus(`Camera unavailable: ${err.message}`);
        return;
      }
    }
    internalRef.current.running = true;
    internalRef.current.totalTokens = 0;
    setRunning(true);
    setStatus('Monitoring…');
    resetFeedback();
    tick();
  }, [settingsRef, tick, videoRef]);

  const stop = useCallback(() => {
    internalRef.current.running = false;
    clearTimeout(internalRef.current.loopTimer);
    if (internalRef.current.abort) internalRef.current.abort.abort();
    if (internalRef.current.stream) {
      internalRef.current.stream.getTracks().forEach(t => t.stop());
      internalRef.current.stream = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    resetFeedback();
    setRunning(false);
    setStatus('Stopped.');
    setDotClass('off');
  }, [videoRef]);

  return { running, status, dotClass, flashActive, telemetry, alerts, start, stop, sendWebhook };
}
