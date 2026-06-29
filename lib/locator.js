// Aura spatial locator.
//
// Wraps the Cerebras Gemma vision call and enforces correct-by-construction
// spatial JSON. When no CEREBRAS_API_KEY is configured we fall back to a
// deterministic mock so the full client/feedback loop can be demoed and tested
// offline (e.g. the side-by-side hackathon demo).

const CEREBRAS_BASE_URL =
  process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'gemma-4-31b';

export const VALID_ACTIONS = [
  'steer_left',
  'steer_right',
  'steer_up',
  'steer_down',
  'hold_center',
];

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

  // If there is leading/trailing prose, isolate the outermost JSON object.
  if (text[0] !== '{') {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error(`No JSON object in response: ${text.slice(0, 120)}`);
    }
    text = text.slice(start, end + 1);
  }

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

export async function locate({ target, image }) {
  if (!process.env.CEREBRAS_API_KEY) {
    return { ...mockLocate(target), mode: 'mock' };
  }

  const body = {
    model: CEREBRAS_MODEL,
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
    resp = await fetch(CEREBRAS_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
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
  return { ...result, mode: 'live' };
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
  };
}
