// Aura BROWSER engine — main-thread facade for in-page vision inference.
//
// All actual model work happens in src/workers/ml.worker.js, the only file
// in the repo that imports @huggingface/transformers (see CLAUDE.md's bundle
// rule — the same one that keeps @ax-llm/ax out of the main bundle). This
// module just owns the worker's lifecycle and speaks its id-correlated
// message protocol, and turns the result into the exact shape scanClient()
// returns so useMonitor/telemetry/history/eval all keep working unchanged.

import {
  buildDetectionPrompt,
  buildActionPrompt,
  buildCompactDetectionPrompt,
  buildCompactActionPrompt,
  buildWebhookActionPrompt,
  parseLooseDetection,
  parseAction,
  parseCompactAction,
  parseWebhookAction,
  normalizeUsage,
  sumUsage,
} from "./monitor.js";
import {
  BROWSER_MODELS,
  DEFAULT_BROWSER_MODEL,
  FALLBACK_BROWSER_MODEL,
  browserModelKeys,
  getBrowserModel,
  pickBrowserModel,
  probeBrowserEnv,
} from "./browser-models.js";
import { probeChromeAI, scanChromeAICall } from "./chrome-ai.js";

// The model table lives in lib/browser-models.js so it — and the hardware
// picker beside it — stay Node-testable without a Worker. Re-exported here
// (together with the Chrome built-in AI probe) because this module is the
// BROWSER engine's public face and every existing caller (useMonitor,
// SettingsScreen, EvalScreen) imports from it.
export {
  BROWSER_MODELS,
  DEFAULT_BROWSER_MODEL,
  FALLBACK_BROWSER_MODEL,
  browserModelKeys,
  getBrowserModel,
  pickBrowserModel,
  probeBrowserEnv,
};
export { probeChromeAI };

// The compact profile answers on one line ("YES 80 someone at the door"); the
// json profile has to fit a whole object, so it gets a bigger budget. Too
// small a budget on the json profile truncates mid-object and every scan
// falls through to parseLooseDetection()'s conservative default.
const MAX_NEW_TOKENS = {
  compact: { detect: 48, action: 40 },
  json: { detect: 160, action: 96 },
};

// Native structured output for the Chrome built-in AI transport, the one
// runtime that can constrain decoding to a JSON Schema (responseConstraint).
// The same normalized detection shape the prompts + parsers produce everywhere
// else — this just makes misformation impossible instead of parseable.
const DETECTION_SCHEMA = {
  type: "object",
  properties: {
    triggered: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["triggered", "confidence", "reason"],
  additionalProperties: false,
};
const MESSAGE_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

// --- Runtime selection ----------------------------------------------------

// The two in-browser runtimes behind the BROWSER engine: the ML worker
// running a BROWSER_MODELS row via Transformers.js, and — where the browser
// offers it — Chrome's built-in Prompt API (Gemini Nano). `runtime` comes
// from aura.browserRuntime: 'auto' | 'transformers' | 'chrome-ai'.
//
// The Auto policy: Chrome built-in AI wins ONLY when it is already
// 'available' AND image-capable. Anything else — 'downloadable' or
// 'downloading' Gemini Nano included — is Transformers.js, because Auto must
// never silently trigger a ~2 GB browser-model download or route vision
// through a text-only build. Getting Gemini Nano onto a device stays an
// explicit choice of the chrome-ai runtime in Settings.
export async function resolveBrowserRuntime(requested = "auto") {
  if (requested === "chrome-ai") return "chrome-ai";
  if (requested === "transformers") return "transformers";
  const probe = await chromeAIProbe();
  return probe.availability === "available" && probe.imageCapable
    ? "chrome-ai"
    : "transformers";
}

// Test seams — mirror _setWorkerFactory(): node --test can't see a real
// LanguageModel, so tests inject a probe/call stand-in instead.
let chromeAIProbe = probeChromeAI;
let chromeAICall = scanChromeAICall;

export function _setChromeAIProbe(fn) {
  chromeAIProbe = fn || probeChromeAI;
}

export function _setChromeAICall(fn) {
  chromeAICall = fn || scanChromeAICall;
}

// --- Worker lifecycle -------------------------------------------------

// Module state: one worker (and one loaded model) for the whole app. A fresh
// Worker() can't run under `node --test`, so tests inject a fake one via
// _setWorkerFactory() below instead of spawning a real worker.
let worker = null;
let workerFactory = defaultWorkerFactory;
let nextId = 1;
let loadedKey = null; // BROWSER_MODELS key of the model currently loaded
let loadedDevice = null; // 'webgpu' | 'wasm', once known
let loadPromise = null; // { key, promise } — in-flight load, de-duplicated
const pending = new Map(); // id -> { resolve, reject, onProgress }

// Resolved as a plain script URL against the document base (same pattern as
// the service-worker registration in src/main.jsx) — deliberately NOT
// `new URL(import.meta.url, ...)`, which would make esbuild try to inline the
// worker's dependency graph (including @huggingface/transformers) into the
// main bundle.
function defaultWorkerFactory() {
  const url = new URL("assets/ml.worker.js", document.baseURI);
  return new Worker(url, { type: "module" });
}

// Test hook — inject a fake worker (postMessage / addEventListener('message')
// / terminate()) instead of spawning a real one.
export function _setWorkerFactory(factory) {
  workerFactory = factory || defaultWorkerFactory;
}

// Test hook — drop all cached worker/model state between tests.
export function _resetBrowserEngine() {
  if (worker) {
    try {
      worker.terminate();
    } catch {
      // Fake worker in tests may not implement terminate(); ignore.
    }
  }
  worker = null;
  loadedKey = null;
  loadedDevice = null;
  loadPromise = null;
  for (const p of pending.values())
    p.reject(new Error("Browser engine was reset."));
  pending.clear();
  // Reset the runtime seams too, so a test that injected a Chrome built-in AI
  // fake can't leak into the next test's runtime resolution.
  chromeAIProbe = probeChromeAI;
  chromeAICall = scanChromeAICall;
}

function ensureWorker() {
  if (worker) return worker;
  worker = workerFactory();
  worker.addEventListener("message", handleMessage);
  // A crashed/OOM'd worker (or one whose module failed to load) fires
  // 'error' instead of ever replying — without this every in-flight scan
  // would hang forever. Reject everything with a message useful enough for
  // useMonitor's existing catch-and-display-status path.
  worker.addEventListener("error", (event) => {
    failAll(
      new Error(
        `Browser engine worker crashed: ${event?.message || "unknown error"}`,
      ),
    );
  });
  worker.addEventListener("messageerror", () => {
    failAll(new Error("Browser engine worker sent an unreadable message."));
  });
  return worker;
}

function failAll(err) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  // The worker is presumed dead — drop all cached state so the next call
  // spins up a fresh one instead of posting into a corpse.
  worker = null;
  loadedKey = null;
  loadedDevice = null;
  loadPromise = null;
}

function handleMessage(event) {
  const msg = event.data || {};
  const p = pending.get(msg.id);
  if (!p) return; // e.g. a late 'result' for a request we already aborted
  if (msg.type === "progress") {
    p.onProgress?.(msg);
    return; // request stays pending until 'ready' / 'result' / 'error'
  }
  pending.delete(msg.id);
  if (msg.type === "error") p.reject(new Error(msg.message || "Browser engine error."));
  else p.resolve(msg);
}

// Post one request and resolve/reject on its matching response. `onProgress`
// (for 'load') is invoked for every intermediate 'progress' message. An
// external abort posts an 'abort' message (so the worker's stopping
// criteria actually halts generation) and settles the promise immediately —
// same "Stop cancels in flight" contract as scanClient()'s AbortController.
function send(type, payload, { onProgress, signal } = {}) {
  const w = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(toAbortError(signal.reason));
      return;
    }
    const onAbort = () => {
      pending.delete(id);
      try {
        w.postMessage({ id, type: "abort" });
      } catch {
        // Worker already gone — nothing to tell it.
      }
      reject(toAbortError(signal.reason));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    pending.set(id, {
      resolve: (msg) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(msg);
      },
      reject: (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
      onProgress,
    });
    w.postMessage({ id, type, ...payload });
  });
}

function toAbortError(reason) {
  if (reason instanceof Error) return reason;
  return new DOMException("Aborted", "AbortError");
}

// --- Model loading ------------------------------------------------------

// Loads (or reuses) the given BROWSER_MODELS entry. De-duplicates concurrent
// calls for the same model — the Monitor screen arming and a Settings "TEST
// ON CURRENT FRAME" click can both trigger a load at once.
export async function loadBrowserModel(modelKey, { onProgress, signal } = {}) {
  const cfg = BROWSER_MODELS[modelKey];
  if (!cfg) throw new Error(`Unknown browser model: ${modelKey}`);
  if (loadedKey === modelKey) return { device: loadedDevice };
  if (loadPromise && loadPromise.key === modelKey) return loadPromise.promise;

  const device =
    typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm";
  const promise = send(
    "load",
    {
      task: "vlm",
      model: cfg.modelId,
      dtype: cfg.dtype,
      device,
      // Only the calling-convention half of the descriptor crosses the wire —
      // the worker has no use for labels or download sizes, and everything in
      // a postMessage has to be structured-cloneable.
      recipe: {
        processorArgs: cfg.processorArgs,
        chatStyle: cfg.chatStyle,
        processorOptions: cfg.processorOptions,
        imageProcessorConfig: cfg.imageProcessorConfig,
      },
    },
    { onProgress, signal },
  )
    .then((msg) => {
      loadedKey = modelKey;
      loadedDevice = msg.device || device;
      loadPromise = null;
      return { device: loadedDevice };
    })
    .catch((err) => {
      loadPromise = null;
      throw err;
    });
  loadPromise = { key: modelKey, promise };
  return promise;
}

export function isBrowserModelLoaded(modelKey) {
  return loadedKey === modelKey;
}

export function browserModelDevice() {
  return loadedDevice;
}

// Unloads the currently-loaded model from the worker (frees VRAM/RAM) without
// tearing down the worker itself.
export async function unloadBrowserModel() {
  if (!worker || !loadedKey) return;
  try {
    await send("unload", { task: "vlm" });
  } finally {
    loadedKey = null;
    loadedDevice = null;
  }
}

// Clears the Cache API bucket Transformers.js stores model weights in, and
// unloads the in-worker model. Used by Settings' CLEAR MODEL CACHE button.
export async function clearBrowserModelCache() {
  await unloadBrowserModel();
  if (typeof caches !== "undefined") {
    // Transformers.js's own default Cache API buckets: model weights, and a
    // second one used to verify Git LFS file hashes. Both are named by the
    // library itself, not chosen here — see @huggingface/transformers'
    // default env.cacheKey.
    await Promise.all(
      ["transformers-cache", "experimental_transformers-hash-cache"].map((name) =>
        caches.delete(name).catch(() => {}),
      ),
    );
  }
}

// --- Scanning -------------------------------------------------------------

// scanClient()-compatible facade: same result shape (mode: 'browser'), so
// useMonitor's dispatch in tick() is a one-line branch.
//
// Which prompts get used is the model's `promptProfile`, not a property of
// the engine. A 256M SmolVLM2 handed the JSON-schema prompts paraphrases them
// back instead of answering — that is what the compact profile exists for —
// while a 450M LFM2.5-VL or a 0.5B FastVLM answers the real schema, and gets
// the same prompts (and therefore the same few-shot examples and GEPA
// artifacts) as the PROVIDER engine.
//
// `examples` and `optimizedInstruction` reach the json profile only: the
// compact profile's builders take nothing but the mission, because a 256M
// context budget spent on few-shot examples buys nothing.
export async function scanBrowser({
  model = DEFAULT_BROWSER_MODEL,
  mission,
  action,
  image,
  images,
  threshold = 60,
  webhookAction,
  webhookSchema,
  examples,
  optimizedInstruction,
  runtime,
  signal,
  onProgress,
  onStage,
} = {}) {
  if (!image && !(images && images.length))
    throw new Error("A camera frame is required.");
  const activeRuntime = runtime || (await resolveBrowserRuntime("auto"));
  const useChrome = activeRuntime === "chrome-ai";
  const cfg = useChrome ? null : getBrowserModel(model);
  if (!useChrome && !cfg) throw new Error(`Unknown browser model: ${model}`);
  onStage?.("loading");
  let modelLoadMs = null;
  if (!useChrome) {
    // One-time cost, reported for the eval screen's load-time column: only
    // the scan that actually pulled/loaded the model pays it.
    const fresh = !isBrowserModelLoaded(model);
    const loadStart = performance.now();
    await loadBrowserModel(model, { onProgress, signal });
    if (fresh) modelLoadMs = Math.round(performance.now() - loadStart);
  }

  const json = useChrome || cfg.promptProfile === "json";
  const budget = MAX_NEW_TOKENS[json ? "json" : "compact"];
  // `images` (a short frame sequence, for temporal models) supersedes `image`;
  // the single-frame path is the normal case and stays exactly that.
  const frameUrls = (images?.length ? images : [image]).map(toDataUrl);

  // One inference shape, two transports: the Chrome built-in AI answers on
  // the main thread (JSON-schema constrained via responseConstraint, and no
  // per-call token cap exists — the schema bounds the output), everything
  // else goes to the ML worker. Same prompt in, same {text, usage} out.
  const infer = (prompt, { schema, maxNewTokens }) =>
    useChrome
      ? chromeAICall({ prompt, imageDataUrls: frameUrls, schema, signal })
      : send("scan", { prompt, imageDataUrls: frameUrls, maxNewTokens }, { signal });

  const detStart = performance.now();
  onStage?.("detecting");
  const detMsg = await infer(
    json
      ? buildDetectionPrompt(mission, examples, optimizedInstruction)
      : buildCompactDetectionPrompt(mission),
    { schema: DETECTION_SCHEMA, maxNewTokens: budget.detect },
  );
  const latencyMs = Math.round(performance.now() - detStart);
  // parseLooseDetection() on both profiles on purpose: it parses the strict
  // schema first and only then falls back to the one-line form, so a json
  // model having an off day degrades instead of throwing mid-scan.
  const detection = parseLooseDetection(detMsg.text);
  let usage = normalizeUsage(detMsg.usage);

  const fired = detection.triggered && detection.confidence >= threshold;
  let message = "";
  let webhookMessage = "";
  if (fired) {
    if ((action || "").trim()) {
      onStage?.("announcing");
      const actMsg = await infer(
        json
          ? buildActionPrompt(action, detection.reason, examples, optimizedInstruction)
          : buildCompactActionPrompt(action, detection.reason),
        { schema: MESSAGE_SCHEMA, maxNewTokens: budget.action },
      );
      message = json
        ? parseAction(actMsg.text).message
        : parseCompactAction(actMsg.text, detection.reason).message;
      usage = sumUsage(usage, normalizeUsage(actMsg.usage));
    } else {
      message = detection.reason;
    }

    if ((webhookAction || "").trim()) {
      onStage?.("webhook");
      const whMsg = await infer(
        buildWebhookActionPrompt(webhookAction, detection.reason, webhookSchema),
        { schema: MESSAGE_SCHEMA, maxNewTokens: budget.action },
      );
      // parseWebhookAction() insists on real JSON. That's right for a model
      // that can produce it and fatal for one that can't — on the compact
      // profile a throw here would fail the whole scan, losing the alert that
      // just fired. Degrade to the plain-text answer instead.
      webhookMessage = json
        ? parseWebhookAction(whMsg.text).message
        : parseCompactAction(whMsg.text, detection.reason).message;
      usage = sumUsage(usage, normalizeUsage(whMsg.usage));
    }
  }

  return {
    triggered: fired,
    confidence: detection.confidence,
    reason: detection.reason,
    message,
    webhookMessage,
    mode: "browser",
    runtime: activeRuntime,
    device: useChrome ? null : browserModelDevice(),
    modelLoadMs,
    latencyMs,
    usage,
  };
}

function toDataUrl(image) {
  return image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
}
