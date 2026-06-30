import { useState, useRef, useCallback } from 'react';
import { scanClient } from '../../lib/aura.js';
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

  const internalRef = useRef({ stream: null, inFlight: false, loopTimer: null, totalTokens: 0, running: false });

  const captureFrame = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, CAPTURE_W, CAPTURE_H);
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
    if (!internalRef.current.inFlight && video && video.readyState >= 2) {
      internalRef.current.inFlight = true;
      const started = performance.now();
      const s = settingsRef.current;
      try {
        const result = await scanClient({
          baseUrl: s.baseUrl || undefined,
          model: s.model || undefined,
          apiKey: s.apiKey || undefined,
          mission: s.mission,
          action: s.action,
          image: captureFrame(),
          threshold: s.threshold ?? 0,
          webhookAction: s.webhookAction || undefined,
          webhookSchema: parseWebhookSchema() || undefined,
          examples: (s.examples || []).length > 0 ? s.examples : undefined,
          optimizedInstruction: s.optimizedInstruction || undefined,
        });
        if (!internalRef.current.running) return;
        const rtt = Math.round(performance.now() - started);
        setDotClass(result.mode === 'live' ? 'live' : result.mode === 'mock' ? 'mock' : 'off');
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
          if (result.webhookMessage) sendWebhook(result.webhookMessage);
        } else {
          setStatus(`Watching — ${result.reason}`);
        }
      } catch (err) {
        if (internalRef.current.running) setStatus(`Error: ${err.message}`);
      } finally {
        internalRef.current.inFlight = false;
      }
    }
    if (internalRef.current.running) {
      internalRef.current.loopTimer = setTimeout(tick, (parseInt(settingsRef.current.scanEvery, 10) || 5) * 1000);
    }
  }, [captureFrame, flashAlert, logAlert, parseWebhookSchema, sendWebhook, settingsRef, videoRef]);

  const start = useCallback(async () => {
    const s = settingsRef.current;
    if (!s.mission.trim()) {
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
      setStatus(`Camera unavailable: ${err.message}`);
      return;
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
