import {
  buildDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  isolateJsonObject,
  normalizeDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
} from './monitor.js';

export {
  buildDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  isolateJsonObject,
  normalizeDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
};

export async function fetchModels(baseUrl, apiKey) {
  const base = (baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Base URL is required.');
  const resp = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Models endpoint HTTP ${resp.status}: ${detail.slice(0, 120)}`);
  }
  const json = await resp.json();
  return (json.data || []).map((m) => m.id).sort();
}

export async function scanClient({ baseUrl, model, apiKey, mission, action, image, threshold = 60, webhookAction, webhookSchema, examples, optimizedInstruction, requestTimeout, signal }) {
  if (!apiKey) throw new Error('No API key configured. Add one in Settings, or use Demo Mode.');
  if (!baseUrl) throw new Error('Provider base URL is required.');
  if (!model) throw new Error('Model name is required.');

  // Per-request timeout in seconds; local models (e.g. Ollama) can be far
  // slower than hosted providers, so this is configurable. Default 30s.
  const timeoutSec = Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : 30;
  const cfg = { baseUrl: baseUrl.replace(/\/+$/, ''), model, apiKey, timeoutMs: timeoutSec * 1000, signal };

  // Time the detection call specifically — it runs every cycle, so its latency
  // is the representative "time to process a frame" that drives the progress
  // estimate and the self-tuning timeout upstream.
  // performance.now() is monotonic — immune to system-clock adjustments that
  // could otherwise yield a negative or wildly wrong latency.
  const detStart = performance.now();
  const det = await callProvider(
    cfg,
    buildDetectionPrompt(mission, examples, optimizedInstruction),
    'Assess the scene now.',
    image,
    0.5
  );
  const latencyMs = Math.round(performance.now() - detStart);
  const detection = normalizeDetection(isolateJsonObject(det.content));
  let usage = det.usage;

  const fired = detection.triggered && detection.confidence >= threshold;
  let message = '';
  let webhookMessage = '';
  if (fired) {
    if ((action || '').trim()) {
      const act = await callProvider(
        cfg,
        buildActionPrompt(action, detection.reason, examples, optimizedInstruction),
        'Produce the announcement.',
        image,
        0.9
      );
      message = parseAction(act.content).message;
      usage = sumUsage(usage, act.usage);
    } else {
      message = detection.reason;
    }

    if ((webhookAction || '').trim()) {
      const wh = await callProvider(
        cfg,
        buildWebhookActionPrompt(webhookAction, detection.reason, webhookSchema),
        'Produce the webhook payload.',
        image,
        0.9
      );
      webhookMessage = parseWebhookAction(wh.content).message;
      usage = sumUsage(usage, wh.usage);
    }
  }

  return {
    triggered: fired,
    confidence: detection.confidence,
    reason: detection.reason,
    message,
    webhookMessage,
    mode: 'live',
    latencyMs,
    usage,
  };
}

async function callProvider(cfg, system, userText, image, temperature) {
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: toDataUrl(image) } },
        ],
      },
    ],
    temperature,
    response_format: { type: 'json_object' },
  };

  const controller = new AbortController();
  const timedOut = { hit: false };
  const timeout = setTimeout(() => {
    timedOut.hit = true;
    controller.abort(new DOMException(`Request exceeded ${cfg.timeoutMs / 1000}s timeout`, 'TimeoutError'));
  }, cfg.timeoutMs);

  // Chain the caller's signal (e.g. the user pressed Stop) so an in-flight
  // request is actually cancelled instead of running to completion in the
  // background and burning tokens.
  const external = cfg.signal;
  const onExternalAbort = () => controller.abort(external.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  let resp;
  try {
    resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Our own timeout gets an actionable message — without this the browser
    // surfaces the opaque "signal is aborted without reason". An external
    // abort (Stop) propagates as-is so the caller can recognize and swallow it.
    if (timedOut.hit) {
      throw new Error(`Provider request timed out after ${cfg.timeoutMs / 1000}s. The model may be slow or unreachable — raise REQUEST TIMEOUT in Settings.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Provider API ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const json = await resp.json();
  return { content: json?.choices?.[0]?.message?.content, usage: normalizeUsage(json?.usage) };
}

function sumUsage(a, b) {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

function toDataUrl(image) {
  return image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
}
