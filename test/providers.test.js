import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PRESETS, isOpenRouter, visionModelIds } from '../lib/providers.js';

test('provider catalogue exposes ten local and ten remote OpenAI-compatible choices', () => {
  assert.equal(PROVIDER_PRESETS.filter((p) => p.group === 'Local').length, 10);
  assert.equal(PROVIDER_PRESETS.filter((p) => p.group === 'Remote').length, 10);
  assert.ok(PROVIDER_PRESETS.some((p) => p.id === 'ollitert'));
  assert.ok(PROVIDER_PRESETS.some((p) => p.id === 'openrouter'));
});

test('visionModelIds trusts explicit image metadata and filters text-only rows', () => {
  assert.deepEqual(visionModelIds([
    { id: 'vision', architecture: { input_modalities: ['text', 'image'] } },
    { id: 'text-only', architecture: { input_modalities: ['text'] } },
    { id: 'mystery' },
  ], { assumeVisionWhenUnknown: false }), ['vision']);
  assert.equal(isOpenRouter('https://openrouter.ai/api/v1'), true);
});
