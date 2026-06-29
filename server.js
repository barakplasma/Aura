// Aura — backend orchestration layer.
//
// Responsibilities:
//   1. Serve the static PWA client from /public.
//   2. Expose POST /api/locate which forwards a compressed camera frame to
//      Cerebras' Gemma vision endpoint, enforces correct-by-construction
//      spatial JSON, and returns a normalized guidance object to the client.
//
// The Cerebras API key never leaves the server. The client only ever talks to
// this orchestration layer.

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { locate } from './lib/locator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load a local .env if present (Node >= 20.6). Real platforms inject env vars
// directly, so this is purely a developer convenience and is best-effort.
try {
  if (typeof process.loadEnvFile === 'function' && fs.existsSync(path.join(__dirname, '.env'))) {
    process.loadEnvFile(path.join(__dirname, '.env'));
  }
} catch {
  /* ignore */
}

const PORT = process.env.PORT || 3000;

const app = express();

// Camera frames are base64 data URLs, so we need a generous body limit.
// 640x480 JPEG @ ~40% quality base64-encodes to well under 1MB, but headroom
// keeps us safe across devices.
app.use(express.json({ limit: '4mb' }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // The service worker must be served from the root scope with no caching
      // so updates roll out immediately.
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: process.env.CEREBRAS_MODEL || 'gemma-4-31b',
    mode: process.env.CEREBRAS_API_KEY ? 'live' : 'mock',
  });
});

// Core spatial guidance endpoint.
// Body: { target: string, image: string (data URL or raw base64) }
// Response: { found, x, y, action, latencyMs, mode }
app.post('/api/locate', async (req, res) => {
  const started = Date.now();
  const { target, image } = req.body || {};

  if (typeof target !== 'string' || target.trim() === '') {
    return res.status(400).json({ error: 'Missing "target" string.' });
  }
  if (typeof image !== 'string' || image.length < 32) {
    return res.status(400).json({ error: 'Missing "image" data.' });
  }

  try {
    const result = await locate({ target: target.trim(), image });
    res.json({ ...result, latencyMs: Date.now() - started });
  } catch (err) {
    console.error('[locate] error:', err.message);
    res.status(502).json({
      error: 'Inference failed.',
      detail: err.message,
      latencyMs: Date.now() - started,
    });
  }
});

app.listen(PORT, () => {
  const mode = process.env.CEREBRAS_API_KEY ? 'LIVE (Cerebras)' : 'MOCK (no API key set)';
  console.log(`Aura listening on http://localhost:${PORT}  —  inference mode: ${mode}`);
});
