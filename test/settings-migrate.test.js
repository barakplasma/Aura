import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacySettings } from '../lib/settings-migrate.js';

// Minimal Storage-like stub over a plain object.
function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key(i) { return Array.from(map.keys())[i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    _dump() { return Object.fromEntries(map); },
  };
}

test('rewrites a raw legacy string as valid JSON', () => {
  const s = makeStorage({ 'aura.apiKey': 'csk-abc123' });
  const n = migrateLegacySettings(s);
  assert.equal(n, 1);
  assert.equal(s.getItem('aura.apiKey'), '"csk-abc123"');
  assert.equal(JSON.parse(s.getItem('aura.apiKey')), 'csk-abc123');
});

test('leaves already-valid JSON values untouched', () => {
  const s = makeStorage({
    'aura.scanEvery': '5',
    'aura.speech': 'true',
    'aura.model': '"gemma-4-31b"',
    'aura.baseUrl': '"https://api.cerebras.ai/v1"',
  });
  const n = migrateLegacySettings(s);
  assert.equal(n, 0);
  assert.equal(s.getItem('aura.scanEvery'), '5');
  assert.equal(s.getItem('aura.speech'), 'true');
  assert.equal(s.getItem('aura.model'), '"gemma-4-31b"');
});

test('ignores non-aura keys even when they are raw strings', () => {
  const s = makeStorage({ 'other.key': 'raw', 'theme': 'dark' });
  const n = migrateLegacySettings(s);
  assert.equal(n, 0);
  assert.equal(s.getItem('other.key'), 'raw');
  assert.equal(s.getItem('theme'), 'dark');
});

test('migrates only the failing keys in a mixed store', () => {
  const s = makeStorage({
    'aura.apiKey': 'csk-legacy',     // raw → migrate
    'aura.baseUrl': 'https://x/v1',  // raw → migrate
    'aura.scanEvery': '5',           // valid JSON → keep
    'plain': 'nope',                 // non-aura → keep
  });
  const n = migrateLegacySettings(s);
  assert.equal(n, 2);
  assert.equal(s.getItem('aura.apiKey'), '"csk-legacy"');
  assert.equal(s.getItem('aura.baseUrl'), '"https://x/v1"');
  assert.equal(s.getItem('aura.scanEvery'), '5');
  assert.equal(s.getItem('plain'), 'nope');
});

test('handles a missing/invalid storage argument', () => {
  assert.equal(migrateLegacySettings(null), 0);
  assert.equal(migrateLegacySettings(undefined), 0);
  assert.equal(migrateLegacySettings({}), 0);
});
