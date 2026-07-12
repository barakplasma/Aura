// Aura training store — localStorage persistence for examples and optimized
// artifacts. Kept free of @ax-llm/ax so the main bundle never pulls it in.

const TRAINING_KEY = "aura.training.examples";
const ARTIFACT_KEY = "aura.training.artifact";

export function getExamples() {
  try {
    return JSON.parse(localStorage.getItem(TRAINING_KEY)) || [];
  } catch {
    return [];
  }
}

export function addExample(example) {
  const examples = getExamples();
  examples.push({ id: Date.now(), ...example });
  localStorage.setItem(TRAINING_KEY, JSON.stringify(examples));
  return examples;
}

export function removeExample(id) {
  const examples = getExamples().filter((e) => e.id !== id);
  localStorage.setItem(TRAINING_KEY, JSON.stringify(examples));
  return examples;
}

export function clearExamples() {
  localStorage.removeItem(TRAINING_KEY);
  return [];
}

export function getOptimizedArtifact() {
  try {
    return JSON.parse(localStorage.getItem(ARTIFACT_KEY));
  } catch {
    return null;
  }
}

export function saveOptimizedArtifact(artifact) {
  if (artifact) {
    localStorage.setItem(ARTIFACT_KEY, JSON.stringify(artifact));
  } else {
    localStorage.removeItem(ARTIFACT_KEY);
  }
}
