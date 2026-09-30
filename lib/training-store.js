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

// A reviewed frame becomes a detection example. A false positive teaches the
// detector NOT to fire on that scene; a false negative teaches it to fire.
// `entry` is an alert or a recent non-alert frame from the history store.
export function exampleFromReview(entry, kind) {
  const triggered = kind === "false-negative";
  return {
    type: "detection",
    sceneDescription: entry.reason || entry.message || "",
    triggered,
    confidence: triggered ? 90 : 0,
    reason: triggered
      ? entry.reason || "Operator marked this as a missed alert."
      : "Operator marked this alert as a false positive.",
  };
}

// The Lab's Examples form, pre-filled from a history entry ("Send to Lab").
// Unlike exampleFromReview this saves nothing and assumes no verdict: it starts
// from what the model actually answered, and the operator sets what it should
// have. Examples are text-only, so the frame is not stored — the form shows it
// alongside for reference.
export function prefillFromEntry(entry, { isAlert, mission = "" }) {
  const conf = Number.isFinite(entry.conf) ? entry.conf : isAlert ? 80 : 0;
  return {
    mission: (mission || "").trim(),
    sceneDescription: entry.reason || entry.message || "",
    triggered: Boolean(isAlert),
    confidence: Math.min(100, Math.max(0, Math.round(conf))),
    reason: entry.reason || "",
    image: entry.image || null,
  };
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
