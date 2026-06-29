// Aura spatial locator.
//
// Wraps the Cerebras Gemma vision call and enforces correct-by-construction
// spatial JSON. When no CEREBRAS_API_KEY is configured we fall back to a
// deterministic mock so the full client/feedback loop can be demoed and tested
// offline (e.g. the side-by-side hackathon demo).
//
// Runtime-agnostic: config is read from an injected `env` object (Cloudflare
// Workers has no process.env), with process.env used only as a convenience
// fallback for Node-based tests.

const DEFAULT_BASE_URL = 'https://api.cerebras.ai/v1/chat/completions';
const DEFAULT_MODEL = 'gemma-4-31b';

export const VALID_ACTIONS = [
  'steer_left',
  'steer_right',
  'steer_up',
  'steer_down',
  'hold_center',
];

export function getConfig(env = {}) {
  const src = env || {};
  const fallback = typeof process !== 'undefined' && process.env ? process.env : {};
  return {
    apiKey: src.CEREBRAS_API_KEY ?? fallback.CEREBRAS_API_KEY,
    baseUrl: src.CEREBRAS_BASE_URL ?? fallback.CEREBRAS_BASE_URL ?? DEFAULT_BASE_URL,
    model: src.CEREBRAS_MODEL ?? fallback.CEREBRAS_MODEL ?? DEFAULT_MODEL,
  };
}

export function buildSystemPrompt(target) {
  return [
    'You are a real-time, low-latency zero-shot coordinate locator for the blind.',
    'Analyze the input image frame and locate the bounding center of the User Target.',
    'Map the image space to a normalized grid where top-left is (0,0) and bottom-right is (100,100).',
    `User Target: "${target}"`,
    'You must return EXACTLY a raw minified JSON object matching the schema below.',
    'Do not output markdown codeblocks. Do not output conversational text.',
    'Schema:',
    '{"found": boolean, "x": number, "y": number, "action": "steer_left" | "steer_right" | "steer_up" | "steer_down" | "hold_center"}',
  ].join('\n');
}

// Strip stray markdown fences / prose and parse the first JSON object found.
// Gemma is instructed to return raw JSON, but we defend against drift to keep
// the real-time loop from stalling on a malformed frame.
export function parseSpatialJson(raw) {
  if (raw == null) throw new Error('Empty model response.');
  let text = String(raw).trim();

  // Remove ```json ... ``` or ``` ... ``` fences if the model added them.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  // Isolate the outermost JSON object unconditionally. This handles leading
  // prose, trailing prose/punctuation, and `{...} extra` cases that a leading
  // `{` check would let through and break JSON.parse on.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object in response: ${text.slice(0, 120)}`);
  }
  text = text.slice(start, end + 1);

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }

  return normalizeResult(obj);
}

// Coerce + validate the model output into a safe, fully-populated guidance
// object. Out-of-range coordinates are clamped; a missing action is derived
// from the coordinates so the client always has something actionable.
export function normalizeResult(obj) {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Response is not an object.');
  }

  const found = Boolean(obj.found);
  const x = clamp(toNumber(obj.x, 50), 0, 100);
  const y = clamp(toNumber(obj.y, 50), 0, 100);

  let action = obj.action;
  if (!VALID_ACTIONS.includes(action)) {
    action = deriveAction(x, y);
  }

  return { found, x, y, action };
}

// Center dead-zone is 35-65 on both axes. Outside it, steer toward center on
// the axis with the larger error. This mirrors the client thresholds and is the
// fallback when the model omits/garbles `action`.
export function deriveAction(x, y, deadzone = 15) {
  const dx = x - 50;
  const dy = y - 50;
  if (Math.abs(dx) <= deadzone && Math.abs(dy) <= deadzone) return 'hold_center';
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'steer_left' : 'steer_right';
  return dy > 0 ? 'steer_up' : 'steer_down';
}

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

export async function locate({ target, image, env }) {
  const cfg = getConfig(env);

  if (!cfg.apiKey) {
    return { ...mockLocate(target), mode: 'mock' };
  }

  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: buildSystemPrompt(target) },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Locate target object.' },
          { type: 'image_url', image_url: { url: toDataUrl(image) } },
        ],
      },
    ],
    temperature: 0.0,
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
  const content = json?.choices?.[0]?.message?.content;
  const result = parseSpatialJson(content);
  return { ...result, mode: 'live', usage: normalizeUsage(json?.usage) };
}

// Normalize the OpenAI-compatible usage block Cerebras returns so the client
// can track token spend. Missing fields default to 0.
export function normalizeUsage(u) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const prompt = n(u?.prompt_tokens);
  const completion = n(u?.completion_tokens);
  const total = n(u?.total_tokens) || prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

// Deterministic-ish mock that spirals the target toward center over successive
// calls, giving the haptic/speech loop realistic motion without an API key.
let mockTick = 0;
function mockLocate(target) {
  mockTick = (mockTick + 1) % 64;
  const t = mockTick / 64;
  // Decaying spiral that converges to ~center.
  const radius = 45 * (1 - t);
  const angle = t * Math.PI * 4;
  const x = clamp(50 + radius * Math.cos(angle), 0, 100);
  const y = clamp(50 + radius * Math.sin(angle), 0, 100);
  return {
    found: true,
    x: Math.round(x),
    y: Math.round(y),
    action: deriveAction(x, y),
    // Per-frame token spend calibrated to real gemma-4-31b usage (640x480 JPEG
    // prompt + tiny JSON reply ≈ 535 in / 29 out), so the cost readout is
    // realistic without a live API key.
    usage: { prompt_tokens: 535, completion_tokens: 29, total_tokens: 564 },
  };
}
