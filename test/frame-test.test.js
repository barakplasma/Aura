import test from 'node:test';
import assert from 'node:assert/strict';
import { runFrameTest, NO_FRAME, TEST_MISSION } from '../lib/frame-test.js';

const clear = { triggered: false, reason: 'empty room', confidence: 7, latencyMs: 300 };

function fakeScans(result = clear) {
  const calls = { provider: [], browser: [], decision: [] };
  return {
    calls,
    scans: {
      provider: async (a) => { calls.provider.push(a); return result; },
      browser: async (a) => { calls.browser.push(a); return result; },
      decision: async (a) => { calls.decision.push(a); return result; },
    },
  };
}

test('no frame is an inline-ready error and calls nothing', async () => {
  const { scans, calls } = fakeScans();
  await assert.rejects(runFrameTest({ settings: { engine: 'provider' }, frame: null, scans }), { message: NO_FRAME });
  assert.deepEqual([calls.provider.length, calls.browser.length, calls.decision.length], [0, 0, 0]);
});

test('provider: one detection call at threshold 0, no action or webhook leg', async () => {
  const { scans, calls } = fakeScans();
  const out = await runFrameTest({
    settings: { engine: 'provider', baseUrl: 'http://x/v1', model: 'm', apiKey: '', mission: 'a dog' },
    frame: 'JPEG',
    scans,
  });
  assert.equal(calls.provider.length, 1);
  const a = calls.provider[0];
  assert.deepEqual([a.baseUrl, a.model, a.mission, a.image, a.threshold], ['http://x/v1', 'm', 'a dog', 'JPEG', 0]);
  assert.equal('action' in a, false);
  assert.equal('webhookAction' in a, false);
  assert.equal(out.engine, 'provider');
  assert.equal(out.verdict.state, 'watching');
  assert.equal(out.verdict.engine, 'provider');
});

test('an unset engine is the provider engine', async () => {
  const { scans, calls } = fakeScans();
  await runFrameTest({ settings: { baseUrl: 'u', model: 'm' }, frame: 'F', scans });
  assert.equal(calls.provider.length, 1);
});

test('a blank mission falls back to a generic one', async () => {
  const { scans, calls } = fakeScans();
  await runFrameTest({ settings: { engine: 'provider', mission: '   ' }, frame: 'F', scans });
  assert.equal(calls.provider[0].mission, TEST_MISSION);
});

test('browser: model and runtime forwarded, progress relayed', async () => {
  const { scans, calls } = fakeScans();
  const onProgress = () => {};
  await runFrameTest({
    settings: { engine: 'browser', browserModel: 'smol', browserRuntime: '', mission: 'x' },
    frame: 'F',
    scans,
    onProgress,
  });
  const a = calls.browser[0];
  assert.deepEqual([a.model, a.runtime, a.threshold, a.onProgress === onProgress], ['smol', 'auto', 0, true]);
});

test('decision: asks the mission question, key passed, and never a fallback', async () => {
  const { scans, calls } = fakeScans({ ...clear, confidence: 91, triggered: true });
  const out = await runFrameTest({
    settings: { engine: 'decision', decisionModel: 'glance-qwen3-vl-4b', decisionUrl: 'https://r/{path}', decisionKey: 'r8_k', mission: 'a person at the door' },
    frame: 'F',
    scans,
  });
  const a = calls.decision[0];
  assert.equal(a.modelId, 'glance-qwen3-vl-4b');
  assert.equal(a.apiKey, 'r8_k');
  assert.equal(a.threshold, 0);
  assert.equal('fallback' in a, false);
  assert.match(a.question.question, /person at the door/);
  assert.equal(out.verdict.state, 'alert');
});

test('a blank decision key is omitted, not sent as an empty string', async () => {
  const { scans, calls } = fakeScans();
  await runFrameTest({ settings: { engine: 'decision', decisionKey: '' }, frame: 'F', scans });
  assert.equal(calls.decision[0].apiKey, undefined);
});

test('a scan that throws propagates its message', async () => {
  const scans = { provider: async () => { throw new Error('401 unauthorized'); } };
  await assert.rejects(runFrameTest({ settings: { engine: 'provider' }, frame: 'F', scans }), { message: '401 unauthorized' });
});
