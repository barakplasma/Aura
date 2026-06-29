// Aura — Cloudflare Worker (Hono).
//
// Static assets (the PWA client in /public) are served by the Workers Assets
// runtime before this script runs; `run_worker_first = ["/api/*"]` in
// wrangler.toml routes only API calls here. So this Worker is purely the
// orchestration layer: it forwards a compressed camera frame to Cerebras'
// Gemma vision endpoint and returns normalized spatial guidance.
//
// The Cerebras API key lives as a Worker secret (env.CEREBRAS_API_KEY) and
// never reaches the client.

// hono/tiny uses Hono's smallest router — ideal for a Worker with a handful of
// routes and a lean bundle.
import { Hono } from 'hono/tiny';
import { locate } from '../lib/locator.js';

const app = new Hono();

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    model: c.env?.CEREBRAS_MODEL || 'gemma-4-31b',
    mode: c.env?.CEREBRAS_API_KEY ? 'live' : 'mock',
  });
});

// Core spatial guidance endpoint.
// Body: { target: string, image: string (data URL or raw base64) }
// Response: { found, x, y, action, latencyMs, mode }
app.post('/api/locate', async (c) => {
  const started = Date.now();

  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const { target, image } = payload || {};
  if (typeof target !== 'string' || target.trim() === '') {
    return c.json({ error: 'Missing "target" string.' }, 400);
  }
  if (typeof image !== 'string' || image.length < 32) {
    return c.json({ error: 'Missing "image" data.' }, 400);
  }

  try {
    const result = await locate({ target: target.trim(), image, env: c.env });
    return c.json({ ...result, latencyMs: Date.now() - started });
  } catch (err) {
    console.error('[locate] error:', err.message);
    return c.json(
      { error: 'Inference failed.', detail: err.message, latencyMs: Date.now() - started },
      502
    );
  }
});

// Any other /api/* path is unknown. (Non-API paths are handled by Workers
// Assets and never reach this Worker.)
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

export default app;
