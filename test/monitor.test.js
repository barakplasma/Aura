import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDetectionPrompt,
  buildActionPrompt,
  parseDetection,
  normalizeDetection,
  parseAction,
  normalizeUsage,
  scan,
} from '../lib/monitor.js';

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

test('normalizeUsage derives total tokens', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 560, completion_tokens: 40 }), {
    prompt_tokens: 560,
    completion_tokens: 40,
    total_tokens: 600,
  });
});

test('scan mock fires on schedule and respects the threshold', async () => {
  const args = { mission: 'watch the door', action: 'say hi', image: 'x'.repeat(64), env: {} };

  // The mock fires every 3rd cycle. Within a few cycles we should see both a
  // non-triggered and a triggered result, each with usage.
  let sawTriggered = false;
  let sawClear = false;
  for (let i = 0; i < 6; i++) {
    const r = await scan({ ...args, threshold: 60 });
    assert.equal(r.mode, 'mock');
    assert.ok(r.usage.total_tokens > 0);
    assert.equal(typeof r.reason, 'string');
    if (r.triggered) {
      sawTriggered = true;
      assert.ok(r.message.length > 0); // action ran → announcement present
    } else {
      sawClear = true;
    }
  }
  assert.ok(sawTriggered && sawClear);
});

test('scan mock never fires when threshold exceeds mock confidence', async () => {
  for (let i = 0; i < 6; i++) {
    const r = await scan({ mission: 'm', action: 'a', image: 'x'.repeat(64), threshold: 95, env: {} });
    assert.equal(r.triggered, false); // mock confidence caps at 82
  }
});
