// Aura — Cloudflare Worker (Hono).
//
// Static assets (the client in /public) are served by the Workers Assets runtime
// before this script runs; `run_worker_first = ["/api/*"]` routes only API calls
// here. This Worker is the orchestration layer: it runs the detection (+ action)
// monitoring loop against Cerebras' Gemma vision model.
//
// The Cerebras API key lives as a Worker secret (env.CEREBRAS_API_KEY) and never
// reaches the client.

import { Hono } from 'hono/tiny';
import { scan } from '../lib/monitor.js';

const app = new Hono();

app.get('/api/health', (c) => {
  return c.json({
    ok: true,
    model: c.env?.CEREBRAS_MODEL || 'gemma-4-31b',
    mode: c.env?.CEREBRAS_API_KEY ? 'live' : 'mock',
  });
});

// Monitoring scan.
// Body: { mission: string, action: string, image: string, threshold?: number,
//         webhookAction?: string, webhookSchema?: object,
//         examples?: object[], optimizedInstruction?: string }
// Response: { triggered, confidence, reason, message, webhookMessage, latencyMs, mode, usage }
app.post('/api/scan', async (c) => {
  const started = Date.now();

  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body.' }, 400);
  }

  const { mission, action, image, threshold, webhookAction, webhookSchema, examples, optimizedInstruction } = payload || {};
  if (typeof image !== 'string' || image.length < 32) {
    return c.json({ error: 'Missing "image" data.' }, 400);
  }

  try {
    const result = await scan({
      mission: typeof mission === 'string' ? mission : '',
      action: typeof action === 'string' ? action : '',
      image,
      threshold: Number.isFinite(threshold) ? threshold : 60,
      webhookAction: typeof webhookAction === 'string' ? webhookAction : '',
      webhookSchema: webhookSchema && typeof webhookSchema === 'object' ? webhookSchema : undefined,
      examples: Array.isArray(examples) ? examples : undefined,
      optimizedInstruction: typeof optimizedInstruction === 'string' ? optimizedInstruction : undefined,
      env: c.env,
    });
    return c.json({ ...result, latencyMs: Date.now() - started });
  } catch (err) {
    console.error('[scan] error:', err.message);
    return c.json(
      { error: 'Inference failed.', detail: err.message, latencyMs: Date.now() - started },
      502
    );
  }
});

// Any other /api/* path is unknown. (Non-API paths are served by Workers Assets.)
app.all('/api/*', (c) => c.json({ error: 'Not found.' }, 404));

export default app;
