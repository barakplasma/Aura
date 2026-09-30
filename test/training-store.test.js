import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleFromReview, prefillFromEntry } from '../lib/training-store.js';

// exampleFromReview is what marking an alert from the timeline saves. These
// are the exact examples the old inline code in useMonitor.markExample wrote,
// so moving it must not change a byte.
test('a false positive teaches "do not fire on this scene"', () => {
  assert.deepEqual(
    exampleFromReview({ id: 1, message: 'Person at door', reason: 'a person stands at the door' }, 'false-positive'),
    {
      type: 'detection',
      sceneDescription: 'a person stands at the door',
      triggered: false,
      confidence: 0,
      reason: 'Operator marked this alert as a false positive.',
    },
  );
});

test('a false negative teaches "fire on this scene"', () => {
  assert.deepEqual(
    exampleFromReview({ id: 2, reason: 'a parcel is on the step' }, 'false-negative'),
    {
      type: 'detection',
      sceneDescription: 'a parcel is on the step',
      triggered: true,
      confidence: 90,
      reason: 'a parcel is on the step',
    },
  );
});

test('the scene falls back to the message, then to nothing; the false-negative reason has a default', () => {
  assert.equal(exampleFromReview({ message: 'msg' }, 'false-positive').sceneDescription, 'msg');
  const bare = exampleFromReview({}, 'false-negative');
  assert.equal(bare.sceneDescription, '');
  assert.equal(bare.reason, 'Operator marked this as a missed alert.');
});

test('Send to Lab starts from what the model answered and stores nothing', () => {
  const alert = prefillFromEntry(
    { conf: 82, message: 'Person at door', reason: 'a person stands at the door', image: 'data:image/jpeg;base64,AAA' },
    { isAlert: true, mission: '  a person at the door ' },
  );
  assert.deepEqual(alert, {
    mission: 'a person at the door',
    sceneDescription: 'a person stands at the door',
    triggered: true,
    confidence: 82,
    reason: 'a person stands at the door',
    image: 'data:image/jpeg;base64,AAA',
  });
  const missed = prefillFromEntry({ conf: 7, reason: 'empty porch', image: null }, { isAlert: false });
  assert.equal(missed.triggered, false);
  assert.equal(missed.confidence, 7);
  assert.equal(missed.mission, '');
  assert.equal(missed.image, null);
});

test('prefill confidence defaults by kind and is clamped to 0-100', () => {
  assert.equal(prefillFromEntry({}, { isAlert: true }).confidence, 80);
  assert.equal(prefillFromEntry({}, { isAlert: false }).confidence, 0);
  assert.equal(prefillFromEntry({ conf: 250 }, { isAlert: true }).confidence, 100);
  assert.equal(prefillFromEntry({ conf: -5 }, { isAlert: false }).confidence, 0);
});
