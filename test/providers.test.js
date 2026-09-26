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

test("benchmark notes match the Image JevBench models under any provider's id", async () => {
  const { benchmarkNote } = await import("../lib/providers.js");
  assert.match(benchmarkNote("gemma-4-31b"), /96\.8 %/);
  assert.match(benchmarkNote("google/gemma-4-31b-it"), /96\.8 %/);
  assert.match(benchmarkNote("gemini-3.1-flash-lite-preview"), /19\.8 s p95/);
  assert.equal(benchmarkNote("gpt-4o-mini"), null);
  assert.equal(benchmarkNote(""), null);
});
