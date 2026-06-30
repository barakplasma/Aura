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

export async function scanClient({ baseUrl, model, apiKey, mission, action, image, threshold = 60, webhookAction, webhookSchema, examples, optimizedInstruction, signal }) {
  if (!apiKey) {
    return { ...mockScan({ mission, action, threshold, webhookAction }), mode: 'mock' };
  }
  if (!baseUrl) throw new Error('Provider base URL is required.');
  if (!model) throw new Error('Model name is required.');

  const cfg = { baseUrl: baseUrl.replace(/\/+$/, ''), model, apiKey };

  const det = await callProvider(
    cfg,
    buildDetectionPrompt(mission, examples, optimizedInstruction),
    'Assess the scene now.',
    image,
    0.5
  );
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
  const timeout = setTimeout(() => controller.abort(), 12000);
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
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Provider API ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const json = await resp.json();
  return { content: json?.choices?.[0]?.message?.content, usage: normalizeUsage(json?.usage) };
}

let mockScanTick = 0;
function mockScan({ mission, action, threshold = 60, webhookAction }) {
  mockScanTick = (mockScanTick + 1) % 6;
  const triggered = mockScanTick % 3 === 0;
  const confidence = triggered ? 82 : 12;
  const fired = triggered && confidence >= threshold;
  const reason = triggered
    ? 'A person is loitering near the entrance and repeatedly looking around.'
    : 'The area looks normal; nothing of concern.';
  const message = fired ? `(mock) ${((action || '').trim()) || 'Please leave the area now.'}` : '';
  const webhookMessage = fired && (webhookAction || '').trim()
    ? `(mock webhook) ${((webhookAction || '').trim()) || 'Alert triggered.'}`
    : '';
  return {
    triggered: fired,
    confidence,
    reason,
    message,
    webhookMessage,
    usage: {
      prompt_tokens: 560,
      completion_tokens: fired ? 40 : 18,
      total_tokens: fired ? 600 : 578,
    },
  };
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

export * from './training.js';
