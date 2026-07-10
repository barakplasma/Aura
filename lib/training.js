// Aura training — ax-powered GEPA optimization. Loaded via dynamic import()
// so @ax-llm/ax stays out of the main bundle; example/artifact persistence
// lives in training-store.js.

import { ai, ax, optimize, f } from '@ax-llm/ax';
import { saveOptimizedArtifact } from './training-store.js';

export * from './training-store.js';

// --- Signatures ------------------------------------------------------------

const detectSig = f()
  .input('mission', f.string('The monitoring mission — what to watch for'))
  .input('sceneDescription', f.string('Description of what is visible in the camera frame'))
  .output('triggered', f.boolean('Whether the alert condition is met'))
  .output('confidence', f.number('Certainty 0-100'))
  .output('reason', f.string('Short factual justification'))
  .build();

const detectGen = ax(detectSig);

const actionSig = f()
  .input('instruction', f.string('What to say or do when an alert triggers'))
  .input('context', f.string('What was detected, as context for the response'))
  .output('message', f.string('The spoken announcement or webhook payload text'))
  .build();

const actionGen = ax(actionSig);

// --- Provider --------------------------------------------------------------

export function createProvider(apiKey, baseUrl, model) {
  return ai({
    name: 'openai',
    apiKey,
    apiURL: baseUrl ? baseUrl.replace(/\/chat\/completions\/?$/, '') : undefined,
    config: { model: model || 'gemma-4-31b' },
  });
}

// --- Optimization ----------------------------------------------------------

const TRAINING_DEFAULTS = {
  numTrials: 8,
  minibatch: true,
  minibatchSize: 4,
  earlyStoppingTrials: 3,
  sampleCount: 1,
  maxMetricCalls: 60,
};

export async function runDetectionOptimization({ apiKey, baseUrl, model, examples, onProgress, signal }) {
  const split = splitExamples(examples);
  if (split.train.length < 2) {
    throw new Error('Need at least 2 detection examples to optimize.');
  }

  const studentAI = createProvider(apiKey, baseUrl, model);
  const teacherAI = createProvider(apiKey, baseUrl, model || 'gemma-4-31b');

  const trainData = split.train.map((ex) => ({
    mission: ex.mission || '',
    sceneDescription: ex.sceneDescription || '',
    triggered: ex.triggered ?? false,
    confidence: ex.confidence ?? 0,
    reason: ex.reason || '',
  }));

  const valData = split.validation.map((ex) => ({
    mission: ex.mission || '',
    sceneDescription: ex.sceneDescription || '',
    triggered: ex.triggered ?? false,
    confidence: ex.confidence ?? 0,
    reason: ex.reason || '',
  }));

  const metric = ({ prediction, example }) => {
    let score = 0;
    if (prediction.triggered === example.triggered) score += 2;
    const confDiff = Math.abs((prediction.confidence || 0) - (example.confidence || 0));
    if (confDiff <= 10) score += 1;
    return score;
  };

  const result = await optimize(detectGen, trainData, metric, {
    studentAI,
    teacherAI,
    ...TRAINING_DEFAULTS,
    validationExamples: valData.length > 0 ? valData : undefined,
    maxMetricCalls: TRAINING_DEFAULTS.maxMetricCalls,
  });

  detectGen.applyOptimization(result.optimizedProgram);
  saveOptimizedArtifact({
    type: 'detection',
    program: result.optimizedProgram,
    bestScore: result.bestScore,
    timestamp: Date.now(),
  });

  return {
    bestScore: result.bestScore,
    program: result.optimizedProgram,
    paretoFront: result.paretoFront,
  };
}

export async function runActionOptimization({ apiKey, baseUrl, model, examples, onProgress, signal }) {
  const split = splitExamples(examples);
  if (split.train.length < 2) {
    throw new Error('Need at least 2 action examples to optimize.');
  }

  const studentAI = createProvider(apiKey, baseUrl, model);
  const teacherAI = createProvider(apiKey, baseUrl, model || 'gemma-4-31b');

  const trainData = split.train.map((ex) => ({
    instruction: ex.instruction || '',
    context: ex.context || '',
    message: ex.message || '',
  }));

  const valData = split.validation.map((ex) => ({
    instruction: ex.instruction || '',
    context: ex.context || '',
    message: ex.message || '',
  }));

  const metric = ({ prediction, example }) => {
    const pred = (prediction.message || '').toLowerCase();
    const exmp = (example.message || '').toLowerCase();
    const overlap = pred.includes(exmp) || exmp.includes(pred) ? 1 : 0;
    return overlap;
  };

  const result = await optimize(actionGen, trainData, metric, {
    studentAI,
    teacherAI,
    ...TRAINING_DEFAULTS,
    validationExamples: valData.length > 0 ? valData : undefined,
    maxMetricCalls: TRAINING_DEFAULTS.maxMetricCalls,
  });

  actionGen.applyOptimization(result.optimizedProgram);
  saveOptimizedArtifact({
    type: 'action',
    program: result.optimizedProgram,
    bestScore: result.bestScore,
    timestamp: Date.now(),
  });

  return {
    bestScore: result.bestScore,
    program: result.optimizedProgram,
    paretoFront: result.paretoFront,
  };
}

// --- Apply optimization to generators --------------------------------------

export function applyDetectionOptimization(artifact) {
  if (artifact && artifact.program) {
    detectGen.applyOptimization(artifact.program);
    return true;
  }
  return false;
}

export function applyActionOptimization(artifact) {
  if (artifact && artifact.program) {
    actionGen.applyOptimization(artifact.program);
    return true;
  }
  return false;
}

// --- Utils -----------------------------------------------------------------

function splitExamples(examples) {
  const shuffled = [...examples].sort(() => Math.random() - 0.5);
  const splitIdx = Math.max(2, Math.floor(shuffled.length * 0.7));
  return {
    train: shuffled.slice(0, splitIdx),
    validation: shuffled.slice(splitIdx),
  };
}
