import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  parseDetection,
  normalizeDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
} from '../lib/monitor.js';
import { scanClient } from '../lib/aura.js';

test('buildDetectionPrompt embeds the mission and schema', () => {
  const p = buildDetectionPrompt('alert if a person is near the pool');
  assert.match(p, /alert if a person is near the pool/);
  assert.match(p, /"triggered": boolean/);
  assert.match(buildDetectionPrompt(''), /anything unusual/); // sensible default
});

test('buildActionPrompt embeds action and detected reason', () => {
  const p = buildActionPrompt('tell them to leave', 'a person is loitering');
  assert.match(p, /tell them to leave/);
  assert.match(p, /a person is loitering/);
  assert.match(p, /"message": string/);
});

test('parseDetection coerces fields and clamps confidence', () => {
  const r = parseDetection('```json\n{"triggered":true,"confidence":140,"reason":"  x  "}\n```');
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 100);
  assert.equal(r.reason, 'x');
});

test('normalizeDetection fills empty reason and coerces types', () => {
  const r = normalizeDetection({ triggered: 0, confidence: '45' });
  assert.equal(r.triggered, false);
  assert.equal(r.confidence, 45);
  assert.ok(r.reason.length > 0);
});

test('parseAction extracts and defaults the message', () => {
  assert.equal(parseAction('{"message":"Please leave."}').message, 'Please leave.');
  assert.ok(parseAction('{"message":""}').message.length > 0);
});

test('buildWebhookActionPrompt embeds action, reason, and optional schema', () => {
  const p = buildWebhookActionPrompt('send details', 'intruder detected');
  assert.match(p, /send details/);
  assert.match(p, /intruder detected/);
  const withSchema = buildWebhookActionPrompt('send details', 'intruder detected', { type: 'object', properties: { alert: { type: 'string' } } });
  assert.match(withSchema, /JSON Schema/);
  assert.match(withSchema, /"alert"/);
});

test('parseWebhookAction extracts and defaults the message', () => {
  assert.equal(parseWebhookAction('{"message":"Alert: intruder"}').message, 'Alert: intruder');
  assert.ok(parseWebhookAction('{"message":""}').message.length > 0);
});

test('normalizeUsage derives total tokens', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 560, completion_tokens: 40 }), {
    prompt_tokens: 560,
    completion_tokens: 40,
    total_tokens: 600,
  });
});

test('scanClient refuses to run without an API key (no silent mock)', async () => {
  await assert.rejects(
    scanClient({ mission: 'watch the door', image: 'x'.repeat(64) }),
    /API key/
  );
});
