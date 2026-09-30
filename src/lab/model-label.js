import { BROWSER_MODELS } from '../../lib/browser-engine.js';
import { getDecisionModel } from '../../lib/decision-models.js';
import { BROWSER_MODEL_PREFIX, CHROME_AI_MODEL_ID, DECISION_MODEL_PREFIX } from '../../lib/eval.js';

// Friendly label + provenance sub-line for an eval model id.
export function evalModelLabel(m) {
  if (m.startsWith(BROWSER_MODEL_PREFIX)) {
    const cfg = BROWSER_MODELS[m.slice(BROWSER_MODEL_PREFIX.length)];
    return { name: cfg?.label || m, sub: `transformers.js · ${cfg?.sizeLabel || ''}` };
  }
  if (m === CHROME_AI_MODEL_ID) {
    return { name: 'Chrome built-in AI', sub: 'Gemini Nano · JSON-constrained' };
  }
  if (m.startsWith(DECISION_MODEL_PREFIX)) {
    const row = getDecisionModel(m.slice(DECISION_MODEL_PREFIX.length));
    return { name: row?.label || m, sub: 'decision · p(yes)' };
  }
  return { name: m, sub: null };
}
