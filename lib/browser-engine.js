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
  buildCompactWebhookActionPrompt,
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
  modelKnownIssue,
  modelUnsupportedReason,
  pickBrowserModel,
  probeBrowserEnv,
} from "./browser-models.js";
import { logitConfidence } from "./logprob.js";
import { probeChromeAI, scanChromeAICall } from "./chrome-ai.js";
import {
  DETECTOR_MODELS,
  DEFAULT_DETECTOR_MODEL,
  detectorModelKeys,
  getDetectorModel,
  pickDetectorModel,
} from "./detector-models.js";

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
  modelKnownIssue,
  modelUnsupportedReason,
  pickBrowserModel,
  probeBrowserEnv,
};
export { probeChromeAI };

// Same story for the object gate's detector table (lib/detector-models.js):
// this module is the worker's only public face, so the rows travel through it.
export {
  DETECTOR_MODELS,
  DEFAULT_DETECTOR_MODEL,
  detectorModelKeys,
  getDetectorModel,
  pickDetectorModel,
};

// The compact profile answers on one line ("YES 80 someone at the door"); the
// json profile has to fit a whole object, so it gets a bigger budget. Too
// small a budget on the json profile truncates mid-object and every scan
// falls through to parseLooseDetection()'s conservative default.
const MAX_NEW_TOKENS = {
  // `action` is the announcement a person actually hears. Measured on the
  // reference phone: 40 tokens cut it mid-clause ("…suggesting"), so the
  // alert explained nothing. Detection stays tight because it runs every
  // scan; the action call runs only when something was already found.
  compact: { detect: 48, action: 80 },
  json: { detect: 160, action: 96 },
};

// Applied to the prose legs (announce, webhook) only, and only to generated
// tokens — see lib/repetition-penalty.js. The detection leg gets none: its
// first token is the verdict, and any penalty there skews the YES-vs-NO
// margin that confidence is read from.
const PROSE_REPETITION_PENALTY = 1.2;

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
let loadedLimits = null; // { maxStorageBufferMB, … } of the worker's GPU device
let loadedRuntime = null; // what the worker's ORT really got: isolated/threads/proxy
const workerLog = []; // unsolicited worker output; newest last, capped
let loadPromise = null; // { key, promise } — in-flight load, de-duplicated
// The object gate's detector is a second, independent slot in the same worker
// — see the 'detect' task in src/workers/ml.worker.js.
let detectorKey = null;
let detectorDevice = null;
let detectorLoadPromise = null;
const pending = new Map(); // id -> { resolve, reject, onProgress }
let workerInitialized = false;

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
  workerInitialized = false;
  loadedKey = null;
  loadedDevice = null;
  loadedLimits = null;
  loadPromise = null;
  detectorKey = null;
  detectorDevice = null;
  detectorLoadPromise = null;
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
  const created = workerFactory();
  worker = created;
  workerInitialized = false;
  created.addEventListener("message", handleMessage);
  // A crashed/OOM'd worker (or one whose module failed to load) fires
  // 'error' instead of ever replying — without this every in-flight scan
  // would hang forever. Reject everything with a message useful enough for
  // useMonitor's existing catch-and-display-status path.
  created.addEventListener("error", (event) => {
    if (worker !== created) return;
    failAll(workerCrashError(event), created);
  });
  created.addEventListener("messageerror", () => {
    if (worker !== created) return;
    failAll(browserEngineError("Browser engine worker sent an unreadable message.", {
      phase: workerInitialized ? pendingPhase() : "worker-initialization",
    }), created);
  });
  return created;
}

function pendingPhase() {
  const request = pending.values().next().value;
  return request?.type === "load" ? "model-load" : request?.type === "scan" ? "inference" : "worker-runtime";
}

function browserEngineError(message, context = {}) {
  const error = new Error(message);
  // The context is deliberately restricted to execution metadata: never put
  // prompts, frames, model output, or provider credentials on an Error that
  // Bugsink may receive.
  error.browserContext = {
    model: loadedKey || "not-loaded",
    backend: loadedDevice || "not-selected",
    // How big a single weight file the session could bind. The difference
    // between 128 and 2048 here is the difference between WebGPU and a
    // silent WASM fallback, so it belongs on the error.
    buffer_mb: loadedLimits?.maxStorageBufferMB ?? "unknown",
    ...context,
  };
  return error;
}

function workerCrashError(event) {
  const detail = event?.message || event?.error?.message || "";
  const phase = workerInitialized ? pendingPhase() : "worker-initialization";
  // An ErrorEvent with no message is its own clue: it is what a worker fires
  // when its script never ran (404, bad MIME, a top-level throw before any
  // handler) or when the OS killed it. Saying "unknown error" there threw away
  // the only signal, and the useful fields lived in browserContext — which the
  // status line never renders. Put them in the message so the phone screen
  // itself names the phase, and a fielded bug report stops being a guess.
  const where = [
    `phase=${phase}`,
    `ready=${workerInitialized ? "yes" : "no"}`,
    event?.filename ? `file=${event.filename}` : null,
    Number.isFinite(event?.lineno) ? `line=${event.lineno}` : null,
    `backend=${loadedDevice || "not-selected"}`,
  ]
    .filter(Boolean)
    .join(" ");
  const hint =
    !detail && phase === "worker-initialization"
      ? " — worker script never reported anything (failed to load, or was killed before start)"
      : "";
  return browserEngineError(`Browser engine worker crashed: ${detail || "no message"} (${where})${hint}`, {
    phase,
    worker_ready: String(workerInitialized),
    worker_file: event?.filename || undefined,
    worker_line: Number.isFinite(event?.lineno) ? String(event.lineno) : undefined,
    worker_column: Number.isFinite(event?.colno) ? String(event.colno) : undefined,
  });
}

function failAll(err, failedWorker = worker) {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  // The worker is presumed dead — drop all cached state so the next call
  // spins up a fresh one instead of posting into a corpse.
  if (failedWorker && worker === failedWorker) {
    try {
      failedWorker.terminate();
    } catch {
      // A test double may not implement terminate().
    }
    worker = null;
  }
  workerInitialized = false;
  loadedKey = null;
  loadedDevice = null;
  loadedLimits = null;
  loadPromise = null;
  detectorKey = null;
  detectorDevice = null;
  detectorLoadPromise = null;
}

function handleMessage(event) {
  const msg = event.data || {};
  if (msg.type === "initialized") {
    workerInitialized = true;
    return;
  }
  // Unsolicited worker output — ORT's own explanation for choosing a CPU
  // fallback, adapter-limit warnings, and so on. Requests are keyed by an id
  // and these carry none, so below they are silently dropped; Android Chrome
  // also exposes no worker console over CDP, which left a CPU-only inference
  // regression with no trace anywhere an operator could read. Echo it to the
  // page console (readable in devtools, by the eval harness, and over CDP)
  // and keep a short tail for the UI.
  if (msg.type === "warn") {
    const text = `[ml.worker] ${String(msg.message ?? "").slice(0, 400)}`;
    workerLog.push({ at: new Date().toISOString(), text });
    if (workerLog.length > 40) workerLog.shift();
    console.warn(text);
    return;
  }
  // The worker's GPU device is gone (driver reset, VK_ERROR_DEVICE_LOST).
  // Every session on it is dead, and the worker cannot make a new device ORT
  // will adopt — so treat it as a crash: fail what is in flight and drop the
  // worker, and the next call spawns a fresh one.
  if (msg.type === "fatal") {
    const text = `[ml.worker] ${String(msg.message ?? "fatal").slice(0, 400)}`;
    workerLog.push({ at: new Date().toISOString(), text });
    if (workerLog.length > 40) workerLog.shift();
    failAll(browserEngineError(`Browser engine lost its GPU: ${msg.message || "device lost"}`, {
      phase: pendingPhase(),
    }));
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return; // e.g. a late 'result' for a request we already aborted
  if (msg.type === "progress") {
    p.onProgress?.(msg);
    return; // request stays pending until 'ready' / 'result' / 'error'
  }
  pending.delete(msg.id);
  if (msg.type === "error") {
    p.reject(browserEngineError(msg.message || "Browser engine error.", {
      phase: p.type === "load" ? "model-load" : p.type === "scan" ? "inference" : "worker-runtime",
    }));
  }
  else p.resolve(msg);
}

// Post one request and resolve/reject on its matching response. `onProgress`
// (for 'load') is invoked for every intermediate 'progress' message. An
// external abort posts an 'abort' message (so the worker's stopping
// criteria actually halts generation) and settles the promise immediately —
// same "Stop cancels in flight" contract as scanClient()'s AbortController.
function send(type, payload, { onProgress, signal, transfer } = {}) {
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
      type,
    });
    if (transfer) w.postMessage({ id, type, ...payload }, transfer);
    else w.postMessage({ id, type, ...payload });
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
  if (loadPromise) {
    if (loadPromise.key === modelKey) return loadPromise.promise;
    // Workers process messages asynchronously.  A second model must wait for
    // the first transition to settle before it can unload/dispose that model,
    // otherwise two large sessions can overlap in RAM/VRAM.
    return loadPromise.promise.catch(() => {}).then(() =>
      loadBrowserModel(modelKey, { onProgress, signal }),
    );
  }

  const beginLoad = (device) => {
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
      loadedLimits = msg.limits ?? null;
      loadedRuntime = msg.runtime ?? null;
      // Mirror it where an operator can look without a debugger attached to a
      // worker (Android Chrome exposes no worker console over CDP, which made
      // a CPU-only regression invisible for a whole session).
      try {
        localStorage.setItem(
          "aura.runtime",
          JSON.stringify({ device: loadedDevice, ...(loadedRuntime || {}) }),
        );
      } catch {}
      loadPromise = null;
      return { device: loadedDevice };
    })
    .catch((err) => {
      loadPromise = null;
      throw err;
    });
    loadPromise = { key: modelKey, promise };
    return promise;
  };

  const selectedDevice = selectBrowserDevice(cfg);
  if (typeof selectedDevice === "string") return beginLoad(selectedDevice);

  // Keep the in-flight selection itself deduplicated too. Without this, two
  // clicks during an adapter probe could create two workers once it resolves.
  const promise = selectedDevice.then(beginLoad).catch((err) => {
    loadPromise = null;
    throw err;
  });
  loadPromise = { key: modelKey, promise };
  return promise;
}

// A browser can expose WebGPU while its adapter lacks shader-f16. All of our
// VLM recipes include at least one fp16 component, and Transformers.js rejects
// those before downloading anything. Do not advertise WebGPU as usable in
// that state: the small fallback can still attempt the WASM backend, while the
// larger WebGPU-only models fail with an actionable explanation.
export function selectBrowserDevice(
  cfg,
  nav = typeof navigator !== "undefined" ? navigator : null,
) {
  if (!nav?.gpu) {
    if (cfg.requiresWebGpu) {
      throw new Error(`${cfg.label} requires WebGPU with fp16 support. This browser does not provide WebGPU.`);
    }
    return "wasm";
  }
  const unsupported = () => {
    if (cfg.requiresWebGpu) {
      throw new Error(
        `${cfg.label} requires WebGPU with fp16 support. This browser's adapter does not provide it.`,
      );
    }
    return "wasm";
  };
  return nav.gpu.requestAdapter().then(
    (adapter) => {
      if (adapter?.features?.has("shader-f16")) return "webgpu";
      return unsupported();
    },
    unsupported,
  );
}

export function isBrowserModelLoaded(modelKey) {
  return loadedKey === modelKey;
}

export function browserModelDevice() {
  return loadedDevice;
}

// The WebGPU limits the loaded session actually got, or null before the first
// load. maxStorageBufferBindingSize is what a single ONNX initializer has to
// fit inside, so this is the number that says whether the model is really on
// the GPU — see lib/webgpu-limits.js.
export function browserDeviceLimits() {
  return loadedLimits;
}

// The execution stack the loaded session actually got — device plus the ORT
// wasm internals that decide GPU vs CPU. `null` before the first load.
export function browserRuntime() {
  return loadedRuntime;
}

// The last unsolicited worker messages — ORT's fallback reasons, adapter-limit
// warnings. Newest last. See `handleMessage`.
export function browserWorkerLog() {
  return workerLog.slice();
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
    loadedLimits = null;
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

// --- Object gate ----------------------------------------------------------

// Loads (or reuses) a detector row from lib/detector-models.js into the same
// worker the VLM runs in. Single-digit megabytes, so unlike the VLM there is
// no progress UI to speak of — but the de-duplication matters just as much,
// because arming and a Settings test can both ask for it at once.
export async function loadDetector(
  modelKey = DEFAULT_DETECTOR_MODEL,
  { onProgress, signal } = {},
) {
  const cfg = getDetectorModel(modelKey);
  if (!cfg) throw new Error(`Unknown detector model: ${modelKey}`);
  if (detectorKey === modelKey) return { device: detectorDevice };
  if (detectorLoadPromise && detectorLoadPromise.key === modelKey)
    return detectorLoadPromise.promise;

  const promise = selectDetectorDevice(cfg)
    .then((device) =>
      send(
        "load",
        { task: "detect", model: cfg.modelId, dtype: cfg.dtype, device },
        { onProgress, signal },
      ).then((msg) => ({ msg, device })),
    )
    .then(({ msg, device }) => {
      detectorKey = modelKey;
      detectorDevice = msg.device || device;
      detectorLoadPromise = null;
      return { device: detectorDevice };
    })
    .catch((err) => {
      detectorLoadPromise = null;
      throw err;
    });
  detectorLoadPromise = { key: modelKey, promise };
  return promise;
}

/**
 * Which backend the detector should ask the worker for.
 *
 * `navigator.gpu` existing is not the same as WebGPU working: headless
 * browsers, blocklisted GPUs and some Android builds expose the API and then
 * return no adapter, and asking ORT for "webgpu" there fails the load outright
 * ("no available backend found") instead of falling back. So probe the
 * adapter, the way selectBrowserDevice() does for the VLM — but never throw:
 * a VLM row can legitimately refuse to run without WebGPU, whereas a 2.4M-
 * parameter detector is always better on WASM than not at all.
 */
export async function selectDetectorDevice(
  cfg,
  nav = typeof navigator !== "undefined" ? navigator : null,
) {
  if (!nav?.gpu?.requestAdapter) return "wasm";
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return "wasm";
    // fp16 weights need shader-f16 on the GPU; int8 and fp32 run anywhere.
    if (cfg?.dtype === "fp16" && !adapter.features?.has?.("shader-f16")) return "wasm";
    return "webgpu";
  } catch {
    return "wasm";
  }
}

export function isDetectorLoaded(modelKey) {
  return detectorKey === modelKey;
}

export function detectorDeviceName() {
  return detectorDevice;
}

/**
 * Run one detector pass over a frame.
 *
 * `bitmap` is an ImageBitmap and is **transferred**, not copied: at one pass
 * every couple of seconds a JPEG encode/decode round trip on the main thread
 * would cost more than the inference does. The caller must not touch it
 * afterwards — the worker closes it.
 *
 * Returns the raw tensors. Decoding them is lib/object-gate.js's job: pure
 * arithmetic, unit-testable, and off the worker's hot path.
 */
export async function detectObjects(
  bitmap,
  { model = DEFAULT_DETECTOR_MODEL, signal } = {},
) {
  const cfg = getDetectorModel(model);
  if (!cfg) throw new Error(`Unknown detector model: ${model}`);
  await loadDetector(model, { signal });
  const msg = await send(
    "detect",
    { bitmap, size: cfg.inputSize },
    { signal, transfer: [bitmap] },
  );
  return {
    logits: msg.logits,
    boxes: msg.boxes,
    dims: msg.logitsDims,
    latencyMs: msg.latencyMs,
  };
}

/** Frees the detector's session without touching the VLM in the same worker. */
export async function unloadDetector() {
  if (!worker || !detectorKey) return;
  try {
    await send("unload", { task: "detect" });
  } finally {
    detectorKey = null;
    detectorDevice = null;
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
  sceneHint,
  runtime,
  signal,
  onProgress,
  onStage,
} = {}) {
  if (!image && !(images && images.length))
    throw new Error("A camera frame is required.");
  // Always resolve: `runtime` may be the literal string "auto" (the persisted
  // default is truthy, so it arrives here rather than as undefined) and must
  // never pass through as a transport name.
  const activeRuntime = await resolveBrowserRuntime(runtime || "auto");
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
  // `purpose` exists for the dev harness: the detection, announcement and
  // webhook legs all arrive as `scan`, and announcement and webhook share one
  // token budget, so `maxNewTokens` cannot separate them. Time-to-alert is the
  // sum of the three, so a p90 that does not say which leg it belongs to is
  // not actionable. The worker ignores the field.
  const infer = (prompt, { schema, maxNewTokens, wantLogits, repetitionPenalty, purpose }) =>
    useChrome
      ? chromeAICall({ prompt, imageDataUrls: frameUrls, schema, signal })
      : send(
          "scan",
          { prompt, imageDataUrls: frameUrls, maxNewTokens, wantLogits, repetitionPenalty, purpose },
          { signal },
        );

  const detStart = performance.now();
  onStage?.("detecting");
  const detMsg = await infer(
    json
      ? buildDetectionPrompt(mission, examples, optimizedInstruction, sceneHint)
      : buildCompactDetectionPrompt(mission),
    { schema: DETECTION_SCHEMA, maxNewTokens: budget.detect, wantLogits: true, purpose: "detect" },
  );
  const latencyMs = Math.round(performance.now() - detStart);
  // parseLooseDetection() on both profiles on purpose: it parses the strict
  // schema first and only then falls back to the one-line form, so a json
  // model having an off day degrades instead of throwing mid-scan.
  const detection = parseLooseDetection(detMsg.text);
  // The YES-vs-NO margin at the first decode step beats a number the model
  // wrote: on the reference phone the 500M claimed "conf 100" for objects that
  // were not in frame, and a written number is just more generated text. The
  // margin is used only when the first token actually was a verdict (so never
  // on a JSON answer, whose first token is "{"); otherwise the parsed
  // confidence stands.
  const fromLogits = logitConfidence(detMsg.logits);
  if (fromLogits != null) detection.confidence = fromLogits;
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
        {
          schema: MESSAGE_SCHEMA,
          maxNewTokens: budget.action,
          repetitionPenalty: PROSE_REPETITION_PENALTY,
          purpose: "announce",
        },
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
        json
          ? buildWebhookActionPrompt(webhookAction, detection.reason, webhookSchema)
          : buildCompactWebhookActionPrompt(webhookAction, detection.reason),
        {
          schema: MESSAGE_SCHEMA,
          maxNewTokens: budget.action,
          repetitionPenalty: PROSE_REPETITION_PENALTY,
          purpose: "webhook",
        },
      );
      // parseWebhookAction() insists on real JSON. That's right for a json
      // profile model and fatal for one that can't produce it — a throw here
      // would fail the whole scan, losing the alert that just fired. On the
      // compact profile the prompt no longer asks for JSON at all, because a
      // 500M model obliged with `{"message":"{"}`; the sentence below is
      // wrapped into the payload by the caller.
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
    // The model's own words, before parsing. `reason` is indistinguishable
    // from parseLooseDetection()'s fallback ("Nothing notable in view.")
    // whether the model honestly saw nothing or produced something the parser
    // could not read, and those two need opposite fixes — a different model
    // versus a different prompt. The Settings test panel shows this so that
    // question is answerable on the phone, without a debugger.
    rawText: detMsg.text,
    // Per-token probabilities from the worker, when the model returned scores.
    // `firstTokenProb` is what the confidence above was derived from, so an
    // operator can tell a model that was sure from a parser that guessed.
    logits: detMsg.logits || null,
    // Detection-leg split of preprocess / prefill (vision encoder + prompt) /
    // decode, from the worker. Says which lever a slow scan needs: fewer
    // tokens, or a cheaper image path.
    timing: detMsg.timing || null,
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
