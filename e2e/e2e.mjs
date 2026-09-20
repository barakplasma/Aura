// Aura e2e harness — runs the REAL app code end to end against REAL models,
// no mocks:
//
//   provider leg   real scanClient() (lib/aura.js) → any OpenAI-compatible
//                  endpoint: a local llama-server/Ollama via E2E_BASE_URL +
//                  E2E_MODEL, or a paid API picked from the ambient env.
//   browser leg    real scanBrowser() (lib/browser-engine.js) → the real
//                  src/workers/ml.worker.js, executed in-process under Node
//                  by the shim in node-worker.mjs → actual
//                  @huggingface/transformers inference on the native CPU EP.
//
// Both legs walk the full pipeline from lib/aura.js's diagram: fixture image
// → detection call → threshold gate → (on trigger) action call → judged
// announcement. Fixtures are the sharp-rendered scenes in fixtures.mjs; the
// pass/fail policy lives in policy.mjs (unit-tested). Orchestration lives
// here and is exercised live, not under node --test.
//
// Usage:
//   npm run e2e                              # both legs, auto provider
//   E2E_BASE_URL=http://127.0.0.1:11434/v1 E2E_MODEL=qwen2.5vl:3b npm run e2e
//   npm run e2e -- --only browser --browser-model smolvlm2-256m
//   npm run e2e -- --only provider

import { scanClient } from "../lib/aura.js";
import {
  _setWorkerFactory,
  scanBrowser,
} from "../lib/browser-engine.js";
import { BROWSER_MODELS, DEFAULT_BROWSER_MODEL, getBrowserModel } from "../lib/browser-models.js";
import { createNodeWorkerShim } from "./node-worker.mjs";
import { buildFixtures } from "./fixtures.mjs";
import { pickProviderTarget, judgeScan } from "./policy.mjs";

// --- argv -------------------------------------------------------------------

const flags = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) continue;
    // Accept both --key=value and --key value; a bare --key stays boolean.
    if (m[2] === undefined && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags[m[1]] = argv[++i];
    } else {
      flags[m[1]] = m[2] ?? true;
    }
  }
}
const only = flags.only || "both"; // provider | browser | both
if (!["provider", "browser", "both"].includes(only)) {
  console.error(`--only must be provider, browser, or both (got '${only}')`);
  process.exit(2);
}

// The browser model is a table key, not a free-form id — the recipe (dtype
// split, processor calling convention, prompt profile) is what the worker
// consumes, and recipes only exist for rows.
const browserModelKey = flags["browser-model"] || DEFAULT_BROWSER_MODEL;
if (!getBrowserModel(browserModelKey)) {
  console.error(
    `Unknown --browser-model '${browserModelKey}'. Known keys: ${Object.keys(BROWSER_MODELS).join(", ")}`,
  );
  process.exit(2);
}

// --- reporting ---------------------------------------------------------------

let failures = 0;

function report(leg, fixtureName, verdict, extra = {}) {
  const tag = verdict.pass ? "PASS" : "FAIL";
  if (!verdict.pass) failures += 1;
  const bits = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`);
  console.log(`[${tag}] ${leg} / ${fixtureName}${bits.length ? "  " + bits.join(" ") : ""}`);
  for (const f of verdict.failures) console.log(`       ✖ ${f}`);
}

// --- provider leg ------------------------------------------------------------

async function runProviderLeg(target, fixtures) {
  console.log(`\n=== PROVIDER leg → ${target.label} (${target.model} @ ${target.baseUrl}) ===`);
  for (const f of fixtures) {
    try {
      const scan = await scanClient({
        baseUrl: target.baseUrl,
        apiKey: target.apiKey,
        model: target.model,
        mission: f.mission,
        // An action prompt on every scan means a trigger walks all the way to
        // the announcement; judgeScan() then insists the message is non-empty.
        action: "Announce in one short sentence what you observed.",
        image: f.dataUrl,
        threshold: 60,
        requestTimeout: 120,
      });
      report("provider", f.name, judgeScan(scan, { expectedTriggered: f.expectedTriggered, expectedMode: "live" }), {
        triggered: scan.triggered,
        confidence: scan.confidence,
        latency: scan.latencyMs,
        tokens: scan.usage?.total_tokens,
        message: JSON.stringify(scan.message || scan.reason || "").slice(0, 72),
      });
    } catch (err) {
      report("provider", f.name, { pass: false, failures: [String(err?.message || err)] });
    }
  }
}

// --- browser leg ---------------------------------------------------------------

async function runBrowserLeg(fixtures) {
  const cfg = getBrowserModel(browserModelKey);
  console.log(`\n=== BROWSER leg → ${browserModelKey} (${cfg.modelId}, ${cfg.sizeLabel}) ===`);

  // The worker shim must exist before the facade's first send — the factory
  // is synchronous, so the (async) in-process import happens up front.
  const workerUrl = new URL("../src/workers/ml.worker.js", import.meta.url);
  const shim = await createNodeWorkerShim(workerUrl);
  _setWorkerFactory(() => shim);

  let lastPct = -10;
  for (const f of fixtures) {
    try {
      const scan = await scanBrowser({
        model: browserModelKey,
        mission: f.mission,
        action: "Announce in one short sentence what you observed.",
        image: f.dataUrl,
        threshold: 60,
        runtime: "transformers",
        onProgress: (p) => {
          if (p.pct >= lastPct + 10) {
            lastPct = p.pct;
            console.log(`       … downloading ${Math.floor(p.pct)}%`);
          }
        },
      });
      report("browser", f.name, judgeScan(scan, { expectedTriggered: f.expectedTriggered, expectedMode: "browser" }), {
        triggered: scan.triggered,
        confidence: scan.confidence,
        runtime: scan.runtime,
        device: scan.device,
        loadMs: scan.modelLoadMs ?? undefined,
        latency: scan.latencyMs,
        message: JSON.stringify(scan.message || scan.reason || "").slice(0, 72),
      });
    } catch (err) {
      report("browser", f.name, { pass: false, failures: [String(err?.message || err)] });
    }
  }
  shim.terminate();
}

// --- main ----------------------------------------------------------------------

const fixtures = await buildFixtures();
console.log(`Aura e2e — ${fixtures.length} fixtures, only=${only}`);

if (only === "both" || only === "provider") {
  const target = pickProviderTarget(process.env);
  await runProviderLeg(target, fixtures);
}
if (only === "both" || only === "browser") {
  await runBrowserLeg(fixtures);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
