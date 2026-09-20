// Decision core for the e2e harness — the only part with judgment in it, and
// therefore the only part under unit test (the runner, e2e.mjs, is
// orchestration and is exercised live). Side-effect-free so the tests can
// import it without dialing anyone.

// Which OpenAI-compatible endpoint the provider leg targets. Explicit
// E2E_BASE_URL + E2E_MODEL wins (that's how a local llama-server/Ollama gets
// tested); otherwise the first ambient API key in a fixed order picks a paid
// provider. Aura itself is keyless-capable for local servers, but the paid
// defaults below all need their key — the harness refuses to guess silently.
export function pickProviderTarget(env) {
  const { E2E_BASE_URL, E2E_MODEL, E2E_API_KEY } = env;
  if (E2E_BASE_URL) {
    if (!E2E_MODEL) {
      throw new Error("E2E_BASE_URL was set, but a custom endpoint also needs E2E_MODEL.");
    }
    return { baseUrl: E2E_BASE_URL, model: E2E_MODEL, apiKey: E2E_API_KEY || "", label: "custom" };
  }

  const presets = [
    { envKey: "OPENROUTER_API_KEY", label: "openrouter", baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash" },
    { envKey: "OPENAI_API_KEY", label: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    { envKey: "GEMINI_API_KEY", label: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  ];
  const preset = presets.find((p) => env[p.envKey]);
  if (!preset) {
    throw new Error(
      "No provider configured: set E2E_BASE_URL + E2E_MODEL (local server), or one of OPENROUTER_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY.",
    );
  }
  const { envKey, label, baseUrl } = preset;
  return { baseUrl, model: env.E2E_MODEL || preset.model, apiKey: env[envKey], label };
}

// The pass/fail policy for one scan against its fixture expectation. Evidence
// over a boolean: every failed check becomes a named failure line, so a red
// leg says WHY it is red (misfire vs. mute alert vs. broken shape).
export function judgeScan(scan, { expectedTriggered, expectedMode }) {
  const failures = [];
  if (scan.mode !== expectedMode) failures.push(`mode: expected ${expectedMode}, got ${scan.mode}`);
  if (scan.triggered !== expectedTriggered) {
    failures.push(
      `triggered: expected ${expectedTriggered}, got ${scan.triggered} (confidence ${scan.confidence}, reason ${JSON.stringify(scan.reason ?? null)})`,
    );
  }
  if (!Number.isFinite(scan.confidence) || scan.confidence < 0 || scan.confidence > 100) {
    failures.push(`confidence: out of 0..100 (${scan.confidence})`);
  }
  if (expectedTriggered) {
    if (!(typeof scan.reason === "string" && scan.reason.trim())) failures.push("reason: empty on a trigger");
    if (!(typeof scan.message === "string" && scan.message.trim())) {
      failures.push("message: alert fired but no announcement text came back");
    }
  }
  if (!Number.isFinite(scan.latencyMs) || scan.latencyMs <= 0) failures.push(`latencyMs: not positive (${scan.latencyMs})`);
  if (!(scan.usage && Number.isFinite(scan.usage.total_tokens) && scan.usage.total_tokens > 0)) {
    failures.push("usage: missing or zero total_tokens");
  }
  return { pass: failures.length === 0, failures };
}
