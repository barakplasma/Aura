// Aura monitor — the detection/action engine.
//
// Each scan cycle runs a DETECTION call: given the operator's mission prompt and
// the current camera frame, Gemma decides whether the alert condition is met and
// how confident it is. If it fires (and clears the confidence threshold), an
// ACTION call generates the spoken announcement from the operator's action
// prompt. Most cycles are detection-only, so the expensive action call happens
// only on a real alert.
//
// Runtime-agnostic: config comes from an injected `env` (Cloudflare Workers has
// no process.env), with a process.env fallback for Node tests. With no API key
// it returns a deterministic mock so the whole loop can be demoed offline.

// Literal defaults only — never touch `process` at module top level: the
// Cloudflare Workers runtime has no `process`, so a top-level reference throws
// ReferenceError when the script is validated. Env overrides are read inside
// getConfig() (from the Workers `env` binding, or process.env under Node).
const DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1/chat/completions';
const DEFAULT_MODEL = 'gemma-4-31b';

// Sampling temperatures. Higher = more varied judgements and more natural,
// less robotic announcements. Detection is kept a touch below the (hotter)
// action call so alerting stays reasonably stable.
const DETECTION_TEMPERATURE = 0.5;
const ACTION_TEMPERATURE = 0.9;

export function getConfig(env = {}) {
  const src = env || {};
  const fallback = typeof process !== 'undefined' && process.env ? process.env : {};
  return {
    apiKey: src.CEREBRAS_API_KEY ?? fallback.CEREBRAS_API_KEY,
    baseUrl: src.CEREBRAS_BASE_URL ?? fallback.CEREBRAS_BASE_URL ?? DEFAULT_BASE_URL,
    model: src.CEREBRAS_MODEL ?? fallback.CEREBRAS_MODEL ?? DEFAULT_MODEL,
  };
}

// --- Prompts --------------------------------------------------------------

export function buildDetectionPrompt(mission, examples, optimizedInstruction) {
  const m = (mission || '').trim() || 'anything unusual, unsafe, or noteworthy';
  const lines = [
    'You are an automated visual monitoring agent observing a live camera feed.',
    `Monitoring mission: "${m}"`,
  ];
  if (optimizedInstruction) {
    lines.push(`Optimized instruction: ${optimizedInstruction}`);
  }
  lines.push(...[
    'Examine the current frame and decide whether the alert condition described by',
    'the mission is TRUE right now. Judge only what is visibly happening in this',
    'frame. Be conservative — do not raise false alarms.',
  ]);
  if (examples && examples.length > 0) {
    const detExamples = examples.filter((ex) => ex.type === 'detection').slice(0, 5);
    if (detExamples.length > 0) {
      lines.push('Here are some examples of expected behavior:');
      for (const ex of detExamples) {
        lines.push(`- Scene: "${ex.sceneDescription || ''}" → triggered: ${ex.triggered}, confidence: ${ex.confidence}, reason: "${ex.reason || ''}"`);
      }
    }
  }
  lines.push(...[
    'Return EXACTLY a raw minified JSON object. No markdown, no commentary.',
    'Schema: {"triggered": boolean, "confidence": number, "reason": string}',
    'confidence is your certainty from 0 to 100; reason is a short factual',
    'description of what you see that justifies the decision.',
  ]);
  return lines.join('\n');
}

export function buildActionPrompt(action, reason, examples, optimizedInstruction) {
  const a = (action || '').trim() || 'Announce a clear warning about what is happening.';
  const lines = [
    'You are the announcement generator for an automated monitor.',
    'The alert condition was just met.',
    `What was detected: "${reason}"`,
    `Operator instruction for the response: "${a}"`,
  ];
  if (optimizedInstruction) {
    lines.push(`Optimized instruction: ${optimizedInstruction}`);
  }
  if (examples && examples.length > 0) {
    const actExamples = examples.filter((ex) => ex.type === 'action').slice(0, 5);
    if (actExamples.length > 0) {
      lines.push('Here are some examples of expected responses:');
      for (const ex of actExamples) {
        lines.push(`- Context: "${ex.context || ''}" → Message: "${ex.message || ''}"`);
      }
    }
  }
  lines.push(...[
    'Write the spoken announcement to broadcast aloud to the people in the scene',
    'right now, following the operator instruction. Keep it to one or two short,',
    'direct sentences. You may reference what is visible in the frame.',
    'Return EXACTLY a raw minified JSON object. No markdown.',
    'Schema: {"message": string}',
  ]);
  return lines.join('\n');
}

export function buildWebhookActionPrompt(action, reason, schema) {
  const a = (action || '').trim() || 'Describe what just happened in detail.';
  const lines = [
    'You are the webhook payload generator for an automated monitor.',
    'The alert condition was just met.',
    `What was detected: "${reason}"`,
    `Operator instruction for the webhook payload: "${a}"`,
    'Generate a strict JSON payload to send to an external webhook.',
  ];
  if (schema && typeof schema === 'object') {
    lines.push('You MUST follow this JSON Schema exactly:');
    lines.push(JSON.stringify(schema, null, 2));
    lines.push('Do not add or omit any properties. Output only the JSON object.');
  } else {
    lines.push('Include whatever information the operator requested.');
  }
  lines.push('Return EXACTLY a raw minified JSON object. No markdown.');
  lines.push('Schema: {"message": string}');
  return lines.join('\n');
}

// --- Parsing / validation -------------------------------------------------

export function isolateJsonObject(raw) {
  if (raw == null) throw new Error('Empty model response.');
  let text = String(raw).trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object in response: ${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

export function parseDetection(raw) {
  return normalizeDetection(isolateJsonObject(raw));
}

export function normalizeDetection(obj) {
  if (typeof obj !== 'object' || obj === null) throw new Error('Response is not an object.');
  const triggered = Boolean(obj.triggered);
  const confidence = clamp(toNumber(obj.confidence, triggered ? 100 : 0), 0, 100);
  let reason = String(obj.reason ?? '').trim().slice(0, 240);
  if (!reason) reason = triggered ? 'Alert condition met.' : 'Nothing notable in view.';
  return { triggered, confidence, reason };
}

export function parseAction(raw) {
  const obj = isolateJsonObject(raw);
  let message = String(obj.message ?? '').trim().slice(0, 300);
  if (!message) message = 'Attention please.';
  return { message };
}

export function parseWebhookAction(raw) {
  const obj = isolateJsonObject(raw);
  let message = String(obj.message ?? '').trim().slice(0, 1000);
  if (!message) message = 'Alert triggered.';
  return { message };
}

export function normalizeUsage(u) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const prompt = n(u?.prompt_tokens);
  const completion = n(u?.completion_tokens);
  const total = n(u?.total_tokens) || prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function sumUsage(a, b) {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

// --- Core scan ------------------------------------------------------------

export async function scan({ mission, action, image, threshold = 60, webhookAction, webhookSchema, examples, optimizedInstruction, env }) {
  const cfg = getConfig(env);
  if (!cfg.apiKey) {
    return { ...mockScan({ mission, action, threshold, webhookAction }), mode: 'mock' };
  }

  const det = await callGemma(
    cfg,
    buildDetectionPrompt(mission, examples, optimizedInstruction),
    'Assess the scene now.',
    image,
    DETECTION_TEMPERATURE
  );
  const detection = parseDetection(det.content);
  let usage = det.usage;

  const fired = detection.triggered && detection.confidence >= threshold;
  let message = '';
  let webhookMessage = '';
  if (fired) {
    if ((action || '').trim()) {
      const act = await callGemma(
        cfg,
        buildActionPrompt(action, detection.reason, examples, optimizedInstruction),
        'Produce the announcement.',
        image,
        ACTION_TEMPERATURE
      );
      message = parseAction(act.content).message;
      usage = sumUsage(usage, act.usage);
    } else {
      message = detection.reason;
    }

    if ((webhookAction || '').trim()) {
      const wh = await callGemma(
        cfg,
        buildWebhookActionPrompt(webhookAction, detection.reason, webhookSchema),
        'Produce the webhook payload.',
        image,
        ACTION_TEMPERATURE
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

async function callGemma(cfg, system, userText, image, temperature) {
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
  const timeout = setTimeout(() => controller.abort(), 8000);
  let resp;
  try {
    resp = await fetch(cfg.baseUrl, {
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
    throw new Error(`Cerebras ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const json = await resp.json();
  return { content: json?.choices?.[0]?.message?.content, usage: normalizeUsage(json?.usage) };
}

// --- Mock -----------------------------------------------------------------

// Cycles through normal/alert states (own tick, no shared state) so the full
// detect→act→announce loop can be exercised without an API key. Fires on every
// third cycle with high confidence.
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

// --- utils ----------------------------------------------------------------

function toNumber(v, fallback) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function toDataUrl(image) {
  return image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
}
