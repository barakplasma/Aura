import { isDecisionConfigured } from './decision-models.js';

// Aura always sends a camera frame, so the curated defaults are image-input
// models. Providers change catalogues frequently; the Fetch models action
// remains the source of truth for what an account can actually use.
export const PROVIDER_PRESETS = [
  { id: 'ollama', label: 'Ollama', group: 'Local', url: 'http://localhost:11434/v1', local: true, models: ['gemma3:4b', 'qwen3-vl:4b'] },
  { id: 'lmstudio', label: 'LM Studio', group: 'Local', url: 'http://localhost:1234/v1', local: true, models: [] },
  { id: 'ollitert', label: 'OlliteRT', group: 'Local', url: 'http://localhost:8000/v1', local: true, models: [] },
  { id: 'litert', label: 'LiteRT-LM', group: 'Local', url: 'http://localhost:9379/v1', local: true, models: ['gemma4-e2b'] },
  { id: 'llamacpp', label: 'llama.cpp', group: 'Local', url: 'http://localhost:8080/v1', local: true, models: [] },
  { id: 'vllm', label: 'vLLM', group: 'Local', url: 'http://localhost:8000/v1', local: true, models: [] },
  { id: 'localai', label: 'LocalAI', group: 'Local', url: 'http://localhost:8080/v1', local: true, models: [] },
  { id: 'jan', label: 'Jan', group: 'Local', url: 'http://localhost:1337/v1', local: true, models: [] },
  { id: 'koboldcpp', label: 'KoboldCpp', group: 'Local', url: 'http://localhost:5001/v1', local: true, models: [] },
  { id: 'textgen', label: 'text-generation-webui', group: 'Local', url: 'http://localhost:5000/v1', local: true, models: [] },
  { id: 'openrouter', label: 'OpenRouter', group: 'Remote', url: 'https://openrouter.ai/api/v1', local: false, models: ['google/gemini-2.5-flash', 'qwen/qwen3-vl-235b-a22b-instruct'] },
  { id: 'openai', label: 'OpenAI', group: 'Remote', url: 'https://api.openai.com/v1', local: false, models: ['gpt-4.1-mini', 'gpt-4o-mini'] },
  { id: 'gemini', label: 'Gemini', group: 'Remote', url: 'https://generativelanguage.googleapis.com/v1beta/openai', local: false, models: ['gemini-2.5-flash', 'gemini-2.5-pro'] },
  { id: 'cerebras', label: 'Cerebras', group: 'Remote', url: 'https://api.cerebras.ai/v1', local: false, models: ['gemma-4-31b'] },
  { id: 'groq', label: 'Groq', group: 'Remote', url: 'https://api.groq.com/openai/v1', local: false, models: ['meta-llama/llama-4-scout-17b-16e-instruct'] },
  { id: 'together', label: 'Together AI', group: 'Remote', url: 'https://api.together.xyz/v1', local: false, models: ['meta-llama/Llama-4-Scout-17B-16E-Instruct'] },
  { id: 'fireworks', label: 'Fireworks AI', group: 'Remote', url: 'https://api.fireworks.ai/inference/v1', local: false, models: ['accounts/fireworks/models/llama4-scout-instruct-basic'] },
  { id: 'mistral', label: 'Mistral AI', group: 'Remote', url: 'https://api.mistral.ai/v1', local: false, models: ['pixtral-12b-2409'] },
  { id: 'deepinfra', label: 'DeepInfra', group: 'Remote', url: 'https://api.deepinfra.com/v1/openai', local: false, models: ['meta-llama/Llama-4-Scout-17B-16E-Instruct'] },
  { id: 'nvidia', label: 'NVIDIA NIM', group: 'Remote', url: 'https://integrate.api.nvidia.com/v1', local: false, models: ['meta/llama-4-scout-17b-16e-instruct'] },
];

export function providerForUrl(baseUrl) {
  return PROVIDER_PRESETS.find((provider) => provider.url === baseUrl) || null;
}

export function isOpenRouter(baseUrl) {
  try {
    return new URL(baseUrl).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

// Model APIs are not consistent. Honor an explicit capability descriptor when
// one exists; otherwise use a conservative VLM-name heuristic rather than
// hiding a provider's whole model list on metadata that was never supplied.
export function visionModelIds(data, { assumeVisionWhenUnknown = true } = {}) {
  return (data || [])
    .filter((entry) => {
      const modalities = entry?.architecture?.input_modalities || entry?.input_modalities || entry?.capabilities?.input_modalities;
      if (Array.isArray(modalities)) return modalities.includes('image');
      if (!assumeVisionWhenUnknown) return false;
      return /(?:vision|\\bvl\\b|llava|pixtral|gemma[ -]?3|gpt-4o|gpt-4\\.1|gpt-5|gemini|claude|llama[ -]?4|qwen[0-9. -]*vl|minicpm|phi-4-multimodal|molmo)/i.test(entry?.id || '');
    })
    .map((entry) => entry?.id)
    .filter(Boolean)
    .sort();
}

// What "configured" means per engine — never the API key (CLAUDE.md): a model
// for BROWSER, a base URL + model for PROVIDER, a decision row (+ its server
// URL when self-hosted) for DECISION.
export function isEngineConfigured(s = {}) {
  if (s.engine === 'browser') return Boolean(s.browserModel);
  if (s.engine === 'decision') return isDecisionConfigured(s);
  return Boolean(s.baseUrl && s.model);
}

// Image JevBench v0.1 (https://benchmarkheaven.com/image-jev-bench, read
// 2026-09-26) for the hosted chat VLMs it measured that Aura's presets reach.
// The everyday-photo track is the one closest to a camera feed. Matched on the
// model id so it shows under any provider serving that model.
export const MODEL_BENCHMARKS = [
  {
    pattern: /gemma[-_ ]?4[-_ ]?31b/i,
    note: 'Image JevBench: 96.8 % on everyday photos, 1.4 s p50 / 2.9 s p95, ~$0.08 per 1,000 decisions.',
  },
  {
    pattern: /gemini[-_ ]?3\.1[-_ ]?flash[-_ ]?lite/i,
    note: 'Image JevBench: 100 % on everyday photos, 1.8 s p50 but a 19.8 s p95 tail, ~$0.39 per 1,000 decisions.',
  },
];

export function benchmarkNote(model) {
  return MODEL_BENCHMARKS.find((b) => b.pattern.test(model || ''))?.note || null;
}
