import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpatialJson,
  normalizeResult,
  deriveAction,
  buildSystemPrompt,
  locate,
  normalizeUsage,
  VALID_ACTIONS,
} from '../lib/locator.js';

test('parseSpatialJson handles raw minified JSON', () => {
  const r = parseSpatialJson('{"found":true,"x":20,"y":80,"action":"steer_left"}');
  assert.deepEqual(r, { found: true, x: 20, y: 80, action: 'steer_left' });
});

test('parseSpatialJson strips markdown code fences', () => {
  const r = parseSpatialJson('```json\n{"found":true,"x":50,"y":50,"action":"hold_center"}\n```');
  assert.equal(r.action, 'hold_center');
});

test('parseSpatialJson recovers JSON embedded in prose', () => {
  const r = parseSpatialJson('Sure! {"found":false,"x":0,"y":0,"action":"steer_up"} done');
  assert.equal(r.found, false);
  assert.equal(r.action, 'steer_up');
});

test('parseSpatialJson recovers JSON with trailing prose/punctuation', () => {
  const r = parseSpatialJson('{"found":true,"x":10,"y":20,"action":"steer_right"} done.');
  assert.equal(r.found, true);
  assert.equal(r.x, 10);
  assert.equal(r.action, 'steer_right');
});

test('parseSpatialJson throws on non-JSON', () => {
  assert.throws(() => parseSpatialJson('no json here'));
});

test('normalizeResult clamps out-of-range coordinates', () => {
  const r = normalizeResult({ found: true, x: 250, y: -40, action: 'hold_center' });
  assert.equal(r.x, 100);
  assert.equal(r.y, 0);
});

test('normalizeResult derives action when missing/invalid', () => {
  const r = normalizeResult({ found: true, x: 90, y: 50, action: 'nonsense' });
  assert.ok(VALID_ACTIONS.includes(r.action));
  assert.equal(r.action, 'steer_left'); // x far right -> move left
});

test('normalizeResult coerces string numbers', () => {
  const r = normalizeResult({ found: true, x: '33', y: '67', action: 'steer_down' });
  assert.equal(r.x, 33);
  assert.equal(r.y, 67);
});

test('deriveAction returns hold_center inside the deadzone', () => {
  assert.equal(deriveAction(50, 50), 'hold_center');
  assert.equal(deriveAction(60, 58), 'hold_center');
});

test('deriveAction picks the dominant axis', () => {
  assert.equal(deriveAction(10, 52), 'steer_right'); // far left
  assert.equal(deriveAction(52, 10), 'steer_down'); // far up
  assert.equal(deriveAction(90, 50), 'steer_left');
  assert.equal(deriveAction(50, 90), 'steer_up');
});

test('buildSystemPrompt embeds the target and schema', () => {
  const p = buildSystemPrompt('water bottle');
  assert.match(p, /User Target: "water bottle"/);
  assert.match(p, /"hold_center"/);
  assert.match(p, /Do not output markdown/);
});

test('normalizeUsage coerces and derives total tokens', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1180, completion_tokens: 18 }), {
    prompt_tokens: 1180,
    completion_tokens: 18,
    total_tokens: 1198,
  });
  assert.deepEqual(normalizeUsage(undefined), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  });
});

test('locate falls back to a valid mock without an API key', async () => {
  const r = await locate({ target: 'keys', image: 'x'.repeat(64), env: {} });
  assert.equal(r.mode, 'mock');
  assert.ok(r.usage && r.usage.total_tokens > 0); // mock reports plausible spend
  assert.equal(typeof r.found, 'boolean');
  assert.ok(r.x >= 0 && r.x <= 100);
  assert.ok(VALID_ACTIONS.includes(r.action));
});
