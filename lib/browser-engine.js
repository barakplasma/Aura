// Aura BROWSER engine — main-thread facade for in-page vision inference.
//
// All actual model work happens in src/workers/ml.worker.js, the only file
// in the repo that imports @huggingface/transformers (see CLAUDE.md's bundle
// rule — the same one that keeps @ax-llm/ax out of the main bundle). This
// module just owns the worker's lifecycle and speaks its id-correlated
// message protocol, and turns the result into the exact shape scanClient()
// returns so useMonitor/telemetry/history/eval all keep working unchanged.

import {
  buildCompactDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  parseLooseDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
} from "./monitor.js";

// Curated model table — id (stored in aura.browserModel) -> config. Only one
// entry in v1 (a 256M model is the only one small enough to be a reasonable
// default download on a phone); kept as a table rather than hardcoding the id
// inline so a future addition is a one-entry change, not a refactor. The
// dtype split (embed_tokens fp16, vision_encoder/decoder q4) is Hugging
// Face's own WebGPU demo recipe for SmolVLM.
export const BROWSER_MODELS = {
  "smolvlm2-256m": {
    modelId: "HuggingFaceTB/SmolVLM2-256M-Video-Instruct",
    dtype: { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" },
    label: "SmolVLM2 256M",
    sizeLabel: "~208 MB",
  },
};

export const DEFAULT_BROWSER_MODEL = "smolvlm2-256m";

const DETECT_MAX_NEW_TOKENS = 48;
const ACTION_MAX_NEW_TOKENS = 40;

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
    { task: "vlm", model: cfg.modelId, dtype: cfg.dtype, device },
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
// useMonitor's dispatch in tick() is a one-line branch. `examples` and
// `optimizedInstruction` are accepted for signature parity with scanClient
// but unused — a 256M model has no useful context budget for few-shot
// examples, and buildCompactDetectionPrompt() only takes the mission.
export async function scanBrowser({
  model = DEFAULT_BROWSER_MODEL,
  mission,
  action,
  image,
  threshold = 60,
  webhookAction,
  webhookSchema,
  signal,
  onProgress,
} = {}) {
  if (!image) throw new Error("A camera frame is required.");
  await loadBrowserModel(model, { onProgress, signal });

  const dataUrl = toDataUrl(image);
  const detStart = performance.now();
  const detMsg = await send(
    "scan",
    {
      prompt: buildCompactDetectionPrompt(mission),
      imageDataUrl: dataUrl,
      maxNewTokens: DETECT_MAX_NEW_TOKENS,
    },
    { signal },
  );
  const latencyMs = Math.round(performance.now() - detStart);
  const detection = parseLooseDetection(detMsg.text);
  let usage = normalizeUsage(detMsg.usage);

  const fired = detection.triggered && detection.confidence >= threshold;
  let message = "";
  let webhookMessage = "";
  if (fired) {
    if ((action || "").trim()) {
      const actMsg = await send(
        "scan",
        {
          prompt: buildActionPrompt(action, detection.reason),
          imageDataUrl: dataUrl,
          maxNewTokens: ACTION_MAX_NEW_TOKENS,
        },
        { signal },
      );
      message = parseAction(actMsg.text).message;
      usage = sumUsage(usage, normalizeUsage(actMsg.usage));
    } else {
      message = detection.reason;
    }

    if ((webhookAction || "").trim()) {
      const whMsg = await send(
        "scan",
        {
          prompt: buildWebhookActionPrompt(webhookAction, detection.reason, webhookSchema),
          imageDataUrl: dataUrl,
          maxNewTokens: ACTION_MAX_NEW_TOKENS,
        },
        { signal },
      );
      webhookMessage = parseWebhookAction(whMsg.text).message;
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
    latencyMs,
    usage,
  };
}

function sumUsage(a, b) {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

function toDataUrl(image) {
  return image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
}
