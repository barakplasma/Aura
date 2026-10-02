import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutAction } from '../lib/shortcuts.js';

const k = (key, extra = {}) => ({ key, ...extra });

test('Space toggles when nothing else owns it', () => {
  assert.deepEqual(shortcutAction(k(' '), { tag: 'BODY' }), { type: 'toggle' });
});

test('Space is left to a focused button, and typing is never intercepted', () => {
  assert.equal(shortcutAction(k(' '), { tag: 'BUTTON', interactive: true }), null);
  assert.equal(shortcutAction(k(' '), { tag: 'TEXTAREA' }), null);
  assert.equal(shortcutAction(k('2'), { tag: 'INPUT' }), null);
  assert.equal(shortcutAction(k('2'), { tag: 'DIV', editable: true }), null);
});

test('1-4 pick the destinations; other digits do nothing', () => {
  assert.deepEqual(shortcutAction(k('1'), { tag: 'BODY' }), { type: 'go', screen: 'watch' });
  assert.deepEqual(shortcutAction(k('4'), { tag: 'BODY' }), { type: 'go', screen: 'lab' });
  assert.equal(shortcutAction(k('5'), { tag: 'BODY' }), null);
  assert.equal(shortcutAction(k('0'), { tag: 'BODY' }), null);
});

test('modifiers, key repeat and open dialogs are ignored', () => {
  assert.equal(shortcutAction(k('1', { ctrlKey: true }), { tag: 'BODY' }), null);
  assert.equal(shortcutAction(k('1', { metaKey: true }), { tag: 'BODY' }), null);
  assert.equal(shortcutAction(k(' ', { repeat: true }), { tag: 'BODY' }), null);
  assert.equal(shortcutAction(k(' '), { tag: 'DIV', inDialog: true }), null);
});
