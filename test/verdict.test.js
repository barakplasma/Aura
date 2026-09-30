import test from 'node:test';
import assert from 'node:assert/strict';
import { fromScan, verdicts } from '../lib/verdict.js';

const now = () => 1234;

test('a fired scan is an alert whose text is the legacy status line', () => {
  const v = fromScan(
    { triggered: true, message: 'Person at the door', reason: 'a person is at the door', confidence: 82.4, latencyMs: 640 },
    { engine: 'provider', threshold: 60, now },
  );
  assert.equal(v.state, 'alert');
  assert.equal(v.text, '⚠ ALERT — Person at the door');
  assert.equal(v.headline, 'Person at the door');
  assert.equal(v.reason, 'a person is at the door');
  assert.equal(v.confidence, 82.4);
  assert.equal(v.threshold, 60);
  assert.equal(v.latencyMs, 640);
  assert.equal(v.engine, 'provider');
  assert.equal(v.at, 1234);
  assert.equal(v.note, null);
});

test('an alert with no message falls back to the reason', () => {
  const v = fromScan({ triggered: true, reason: 'motion by the gate', confidence: 90 }, { now });
  assert.equal(v.headline, 'motion by the gate');
  assert.equal(v.text, '⚠ ALERT — motion by the gate');
});

test('a clear scan is "watching", the reason is the headline', () => {
  const v = fromScan({ triggered: false, reason: 'empty porch', confidence: 12 }, { engine: 'browser', now });
  assert.equal(v.state, 'watching');
  assert.equal(v.text, 'Watching — empty porch');
  assert.equal(v.headline, 'empty porch');
  assert.equal(v.engine, 'browser');
});

test('a decision fallback on a clear scan is "degraded" with the full error kept', () => {
  const v = fromScan(
    { triggered: false, reason: 'quiet', confidence: 5, fallbackReason: 'Decision API 422: image is required' },
    { engine: 'decision', now },
  );
  assert.equal(v.state, 'degraded');
  assert.equal(v.text, 'Watching — quiet · decision model failed (Decision API 422: image is required); the provider answered');
  assert.equal(v.note.kind, 'fallback');
  assert.equal(v.note.detail, 'Decision API 422: image is required');
});

test('an alert keeps its state when the announcer failed; the note rides along', () => {
  const v = fromScan(
    { triggered: true, message: 'Dog on the couch', reason: 'r', confidence: 71, announceError: 'timeout' },
    { now },
  );
  assert.equal(v.state, 'alert');
  assert.equal(v.text, '⚠ ALERT — Dog on the couch · announcer failed (timeout)');
  assert.deepEqual(v.note, { kind: 'announcer', text: 'Announcer failed — the template spoke', detail: 'timeout' });
});

test('a fallback outranks an announcer failure, matching the legacy suffix', () => {
  const v = fromScan({ triggered: false, reason: 'x', fallbackReason: 'f', announceError: 'a' }, { now });
  assert.equal(v.note.kind, 'fallback');
});

test('non-finite confidence and latency become null, not NaN', () => {
  const v = fromScan({ triggered: false, reason: 'r', confidence: NaN, latencyMs: undefined }, { now });
  assert.equal(v.confidence, null);
  assert.equal(v.latencyMs, null);
});

test('lifecycle texts are exactly the strings useMonitor used to write', () => {
  assert.equal(verdicts.idle(now).text, 'Configure a provider and press Start.');
  assert.equal(verdicts.starting('camera', now).text, 'Starting camera…');
  assert.equal(verdicts.starting('screen', now).text, 'Requesting screen share…');
  assert.equal(verdicts.loading('SmolVLM2', 61, now).text, 'Loading SmolVLM2 — 61%');
  assert.equal(verdicts.monitoring('provider', 0, now).text, 'Monitoring…');
  assert.equal(verdicts.stopped(now).text, 'Stopped.');
  assert.equal(verdicts.background(now).text, 'Background — scans throttled by the browser.');
  assert.equal(
    verdicts.reconnecting({ hidden: false, attempt: 2, total: 5 }, now).text,
    'Camera lost — reconnecting (2/5)…',
  );
  assert.equal(
    verdicts.reconnecting({ hidden: true, attempt: 1, total: 5 }, now).text,
    'Camera paused in background — resumes on return.',
  );
});

test('failures are "error" verdicts that name the setting that cures them', () => {
  const cases = [
    [verdicts.notConfigured('browser', now), 'Pick a BROWSER MODEL in Settings, or use Demo Mode.', 'browserModel'],
    [verdicts.notConfigured('decision', now), 'Pick a DECISION model (and its server URL, if self-hosted) in Settings, or use Demo Mode.', 'decisionModel'],
    [verdicts.notConfigured('provider', now), 'Set a provider Base URL and model in Settings, or use Demo Mode.', 'baseUrl'],
    [verdicts.needMission(now), 'Describe the mission (what to watch for) first.', 'mission'],
  ];
  for (const [v, text, fixField] of cases) {
    assert.equal(v.state, 'error');
    assert.equal(v.text, text);
    assert.equal(v.error.fixField, fixField);
  }
  assert.equal(verdicts.sourceUnavailable('camera', 'denied', now).text, 'Camera unavailable: denied');
  assert.equal(verdicts.sourceUnavailable('screen', 'denied', now).text, 'Screen share unavailable: denied');
  assert.equal(verdicts.cameraLost('gone', now).text, 'Camera lost — tap ARM to retry. (gone)');
  assert.equal(verdicts.cameraSwitchFailed('busy', now).text, 'Camera switch failed: busy');
  assert.equal(verdicts.scanError('boom', now).text, 'Error: boom');
  assert.equal(verdicts.scanError('boom', now).error.message, 'boom');
});

test('the budget-mode notice is degraded, with a note the sheet can show', () => {
  const v = verdicts.budgetFallback('provider', now);
  assert.equal(v.state, 'degraded');
  assert.equal(v.note.kind, 'budget');
  assert.match(v.text, /^Budget mode: provider returns no token usage/);
});

test('a scan verdict carries the history entry it produced, or null', () => {
  assert.equal(fromScan({ triggered: true, message: 'm', reason: 'r' }, { entryId: 42, now }).entryId, 42);
  assert.equal(fromScan({ triggered: false, reason: 'r' }, { now }).entryId, null);
  assert.equal(verdicts.stopped(now).entryId, null);
});
