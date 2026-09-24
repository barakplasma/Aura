// Aura ML worker — the ONLY file in this repo that imports
// @huggingface/transformers (see CLAUDE.md's bundle rule: the same one that
// keeps @ax-llm/ax out of the main bundle via a separate dynamic import).
// Runs a small vision-language model (see lib/browser-models.js for the
// table) entirely in this worker so the BROWSER engine never touches
// src/App.jsx's static import graph.
//
// Message protocol (see docs/PRD-browser-engine.md and lib/browser-engine.js,
// the main-thread facade that speaks it):
//   -> { id, type: 'load',   task: 'vlm', model, dtype, device, recipe }
//        `recipe` is the per-model calling convention taken straight off
//        lib/browser-models.js's descriptor — processorArgs, chatStyle,
//        processorOptions, imageProcessorConfig. transformers.js is not
//        consistent across VLM families, so these differences are data the
//        main thread hands over rather than branches on modelId in here.
//   <- { id, type: 'progress', file, loaded, total, pct }   (repeated)
//        `file` is whichever file's own event triggered this message, but
//        loaded/total/pct are the running total across every file seen so
//        far against the model's overall expected download size (see
//        lib/model-size.js + lib/download-progress.js) — not that one file's
//        own numbers — so pct only goes up as the load progresses.
//   <- { id, type: 'ready',  device: 'webgpu' | 'wasm', runtime, yesNoIds }
//   <- { type: 'fatal', message }   the GPU device was lost; the page must
//        terminate this worker and spawn a fresh one (nothing here recovers)
//   -> { id, type: 'scan',   prompt, imageDataUrls, maxNewTokens, wantLogits,
//        repetitionPenalty, purpose }
//        `purpose` ('detect' | 'announce' | 'webhook') is unused here; the dev
//        latency harness reads it because the three generation legs are
//        otherwise inseparable on the wire — announce and webhook share one
//        token budget, so `maxNewTokens` cannot tell them apart.
//        `imageDataUrls` is a frame list — normally exactly one entry; a
//        temporal model receives a short sequence. (The older single
//        `imageDataUrl` field is still accepted.)
//   <- { id, type: 'result', text, usage, latencyMs }
//   -> { id, type: 'abort' }                                 (stop mid-generate)
//   -> { id, type: 'unload', task }
//   <- { id, type: 'error',  message }
//
// Only the 'vlm' task is implemented — a 'clip' task belongs to the separate
// PRD-local-prefilters.md and is out of scope here, but the `task` field
// already exists so adding it later doesn't require a protocol change.

import {
  AutoProcessor,
  AutoModel,
  AutoModelForImageTextToText,
  AutoTokenizer,
  RawImage,
  StoppingCriteria,
  Tensor,
  env,
} from "@huggingface/transformers";
import { fetchModelSizeEstimate } from "../../lib/model-size.js";
import { createProgressState, recordProgress, aggregateProgress } from "../../lib/download-progress.js";
import { deviceRequest, limitReport } from "../../lib/webgpu-limits.js";
import { verdictStats, verdictTokenIds } from "../../lib/logprob.js";
import { makeLogitCapture } from "../../lib/logit-capture.js";
import { generatedRepetitionPenalty } from "../../lib/repetition-penalty.js";

// Point ONNX Runtime Web at same-origin WASM files instead of its default CDN,
// so the browser engine works offline once cached (see scripts/build-react.js,
// which copies these from node_modules/onnxruntime-web/dist into public/ort/,
// and scripts/sw-template.js's runtime cache rule for ort/). `.href` matters:
// onnxruntime-web only treats wasmPaths as a directory prefix when it's a
// plain string, not a URL object.
//
// Do NOT "helpfully" pin the pair as { mjs, wasm }. The file names in
// onnxruntime-web 1.31.0-dev are misleading: the glue that actually defines
// `webgpuInit` is `ort-wasm-simd-threaded.asyncify.mjs`, while
// `ort-wasm-simd-threaded.jsep.mjs` is a 30 KB loader that defines nothing.
// Asking for the jsep pair therefore yields
// "no available backend found. ERR: [webgpu] TypeError: … webgpuInit is not a
// function", i.e. it *breaks* WebGPU rather than enabling it. Let ORT choose.
env.backends.onnx.wasm.wasmPaths = new URL("../ort/", self.location).href;

// A StoppingCriteria whose interrupt() can be flipped mid-generation so an
// 'abort' message stops decoding within one token instead of running to
// completion. Not exported by @huggingface/transformers itself — this is
// the pattern used in Hugging Face's own WebGPU demo apps.
class InterruptableStoppingCriteria extends StoppingCriteria {
  constructor() {
    super();
    this.interrupted = false;
  }
  interrupt() {
    this.interrupted = true;
  }
  reset() {
    this.interrupted = false;
  }
  _call(input_ids) {
    return new Array(input_ids.length).fill(this.interrupted);
  }
}

// Ask for a WebGPU device with the adapter's own limits, and hand it to ONNX
// Runtime before the first session exists. ORT otherwise creates its device
// with the spec minimum limits, whose 128 MB maxStorageBufferBindingSize is
// smaller than a merged-decoder initializer, and the session then falls back
// to WASM without saying so — see lib/webgpu-limits.js for the measurement.
//
// Assign, never read: `env.backends.onnx.webgpu.device` is itself
// device-creating, so reading it here would choose a device for us.
//
// Bounded because creating a device is a new blocking step in the load path,
// and a WebGPU device request has been observed to stall indefinitely on this
// driver while another device is live. Giving up costs only the raised limit —
// ONNX Runtime then creates the same default device it always did.
//
// Returns the resulting limits for the 'ready' message, or null when WebGPU
// isn't in play or the request failed — a device we couldn't raise is not a
// reason to abandon a load that would otherwise have worked on WASM.
const DEVICE_REQUEST_TIMEOUT_MS = 20000;

// One device per worker. ORT's WebGPU backend initialises once, on the first
// session, and keeps whatever device it found; assigning a new one on a later
// model swap would be ignored (and leaked) while the report described a device
// nothing uses.
let gpu = null; // { device, report } once a raised-limit device exists

async function useAdapterLimits(device) {
  if (device !== "webgpu" || typeof navigator?.gpu?.requestAdapter !== "function") return null;
  if (gpu) return gpu.report;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    const request = deviceRequest(adapter);
    // Nothing to ask for (no reported buffer limits) means asking would create
    // a device for no gain — leave ONNX Runtime to make its own.
    if (!request) return null;
    const pending = adapter.requestDevice(request);
    let timer;
    const gpuDevice = await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          // The request keeps running after we stop waiting; a device it
          // delivers late would sit beside ORT's own, holding GPU memory.
          pending.then((late) => late?.destroy?.(), () => {});
          reject(new Error(`requestDevice() stalled past ${DEVICE_REQUEST_TIMEOUT_MS}ms`));
        }, DEVICE_REQUEST_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    // A lost device does not come back, and every later session call on it
    // fails or hangs. Say so once; the page tears this worker down.
    gpuDevice.lost?.then((info) => {
      if (info?.reason === "destroyed") return;
      post({ type: "fatal", message: `WebGPU device lost: ${info?.message || info?.reason || "unknown"}` });
    });
    env.backends.onnx.webgpu.device = gpuDevice;
    // The adapter travels along so the UI can show granted-vs-asked-for: a
    // Worker may be handed a lower-limit adapter than the page that spawned it.
    gpu = { device: gpuDevice, report: limitReport(gpuDevice, adapter) };
    return gpu.report;
  } catch (err) {
    post({ type: "warn", message: `WebGPU adapter limits unavailable (${err?.message || err}); falling back to default device limits.` });
    return null;
  }
}

// What the execution stack actually ended up being, as opposed to what we
// asked for: `device: "webgpu"` in a load request only says a session was
// created. These are the inputs that decide whether that session can really
// use the GPU — cross-origin isolation and thread count — plus the WASM
// directory ORT was pointed at, so an observation can be compared against
// measured scan latency rather than argued about. (A WASM *file name* turned
// out not to identify the device: see the note above `wasmPaths`.)
function runtimeInfo() {
  const wasm = env.backends?.onnx?.wasm || {};
  return {
    isolated: !!self.crossOriginIsolated,
    threads: navigator.hardwareConcurrency ?? null,
    numThreads: wasm.numThreads ?? null,
    proxy: !!wasm.proxy,
    wasmPaths: String(wasm.wasmPaths ?? ""),
  };
}

const DEFAULT_MAX_NEW_TOKENS = 48;

// One model loaded at a time — the app only ever runs one BROWSER-engine
// model concurrently, and holding two in VRAM/RAM would be wasteful.
let current = null; // { task, modelId, device, model, processor, recipe, stopping }
// The object gate's detector (docs/PRD-object-gate.md) lives in this same
// worker rather than a second one: one ORT instance, one WebGPU device, one
// adapter-limits call, one cache bucket. It is a separate slot rather than
// part of `current` because it coexists with the VLM — single-digit megabytes
// beside a model three orders of magnitude bigger.
let detector = null; // { modelId, device, model }
let operationQueue = Promise.resolve();

// Lets the facade distinguish an import/initialisation failure from a model
// load or inference failure. This is intentionally emitted only after this
// module and its Transformers.js imports have evaluated successfully.
post({ type: "initialized" });

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const { id, type } = data;
  if (type === "abort") {
    handleAbort(data);
    return;
  }
  // Loading, scanning, and unloading all touch the singleton model. Queue
  // them so a model switch cannot allocate over an in-flight scan or let an
  // older load overwrite a newer one.
  operationQueue = operationQueue.then(async () => {
    try {
      if (type === "load") await handleLoad(id, data);
      else if (type === "scan") await handleScan(id, data);
      else if (type === "detect") await handleDetect(id, data);
      else if (type === "unload") await handleUnload(id, data);
      else post({ id, type: "error", message: `Unknown message type: ${type}` });
    } catch (err) {
      post({ id, type: "error", message: err?.message || String(err) });
    }
  });
});

function post(msg, transfer) {
  if (transfer) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

// ONNX Runtime explains a WebGPU→CPU downgrade with a console warning, and
// transformers.js does the same when a requested device is unavailable — but
// Android Chrome exposes no worker console over CDP, and nothing in the app
// displayed these lines, so the reason a GPU-attached phone executed every
// graph on one CPU thread vanished completely. Forward them to the page, which
// echoes to its console and keeps a tail (lib/browser-engine.js handleMessage).
for (const kind of ["warn", "error"]) {
  const original = console[kind].bind(console);
  console[kind] = (...args) => {
    original(...args);
    try {
      const text = args
        .map((a) => (typeof a === "string" ? a : String(a?.message ?? a)))
        .join(" ");
      post({ type: "warn", message: `${kind}: ${text}` });
    } catch {
      // A worker under memory pressure can fail to clone; the original console
      // line already went out, so losing the forward is not worth throwing over.
    }
  };
}

async function handleLoad(id, { task, model, dtype, device, recipe }) {
  if (task === "detect") return handleLoadDetector(id, { model, dtype, device });
  if (task !== "vlm") throw new Error(`Unsupported task: ${task}`);

  // Already loaded with the same model + device — nothing to do.
  if (current && current.modelId === model && current.device === device) {
    post({ id, type: "ready", device: current.device, limits: current.limits ?? null, runtime: runtimeInfo() });
    return;
  }
  // Swapping models: dispose the old sessions before allocating a new model.
  await disposeCurrent();

  const resolvedDevice =
    device || (typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm");
  const limits = await useAdapterLimits(resolvedDevice);

  // transformers.js reports progress per file (config.json, tokenizer.json,
  // each ONNX weight shard, ...), one at a time — forwarding each event's own
  // loaded/total verbatim makes the bar snap back to ~0% every time a small
  // finished file hands off to the next big one. Instead, track bytes loaded
  // per file and report the running sum against a fixed expected grand total
  // (fetched once, upfront, from the Hub's file listing) so the percentage
  // only ever goes up. If that fetch fails (offline, blocked, unknown repo)
  // we fall back to summing only the totals we've actually seen so far —
  // still monotonic within a file, just not guaranteed monotonic across the
  // file-to-file handoff.
  let expectedTotal = null;
  fetchModelSizeEstimate(model, dtype).then((bytes) => {
    expectedTotal = bytes;
  });
  const progressState = createProgressState();

  const progress_callback = (info) => {
    if (!info || (info.status !== "progress" && info.status !== "download")) return;
    recordProgress(progressState, info);
    const { loaded, total, pct } = aggregateProgress(progressState, expectedTotal);
    post({ id, type: "progress", file: info.file, loaded, total, pct });
  };

  const processor = await AutoProcessor.from_pretrained(model, { progress_callback });

  // Some image processors read their options off their own config rather than
  // from per-call kwargs — LFM2-VL's `_call` accepts only return_row_col_info,
  // so do_image_splitting can only be turned off by setting the property. The
  // recipe says which properties, so this stays one loop for every family.
  if (recipe?.imageProcessorConfig && processor.image_processor) {
    Object.assign(processor.image_processor, recipe.imageProcessorConfig);
  }

  const vlm = await AutoModelForImageTextToText.from_pretrained(model, {
    dtype,
    device: resolvedDevice,
    progress_callback,
  });

  // Verdict vocabulary ids, resolved once per model — every casing that is a
  // single token, since the model may answer "Yes" to a prompt that says
  // "YES". Some families encode the words as several tokens, in which case
  // the lists are empty and the margin column is simply absent; the per-token probability of the
  // emitted token still works without it. The tokenizer itself may also be
  // absent: transformers.js 4.3 processors do not always attach one, and the
  // reference phone's ready line reported `yes/no ids=null` for every model
  // while the Node tokenizer probe resolved single-token YES/NO from the same
  // repos via AutoTokenizer — so fall back to an explicit load.
  const verdictTokenizer =
    processor.tokenizer ?? (await AutoTokenizer.from_pretrained(model));
  const yesNoIds = {
    yes: verdictTokenIds(verdictTokenizer, "YES"),
    no: verdictTokenIds(verdictTokenizer, "NO"),
  };
  current = {
    task,
    modelId: model,
    device: resolvedDevice,
    limits,
    model: vlm,
    processor,
    recipe: recipe || {},
    stopping: new InterruptableStoppingCriteria(),
    verdictIds: yesNoIds,
  };
  // yesNoIds is for the harnesses: the probe's ready line prints it, and a
  // null here is the difference between "the margin is off" and "the margin
  // says the model is 98.8% NO" — which was a wrong-id artefact, not a
  // verdict.
  post({ id, type: "ready", device: resolvedDevice, limits, runtime: runtimeInfo(), yesNoIds });
}

async function handleScan(
  id,
  { prompt, imageDataUrls, imageDataUrl, maxNewTokens, wantLogits, repetitionPenalty, purpose },
) {
  if (!current) throw new Error("No model loaded — send a 'load' message first.");
  const { model, processor, recipe, stopping, verdictIds } = current;
  stopping.reset();
  const start = performance.now();

  // A scan carries a frame list (normally exactly one; a temporal model gets
  // a short sequence). imageDataUrl is still accepted so an older facade
  // bundle keeps working across a service-worker update overlap.
  const urls = imageDataUrls?.length ? imageDataUrls : [imageDataUrl];
  const images = await Promise.all(
    urls.filter(Boolean).map((url) => RawImage.fromURL(url)),
  );
  // Two chat-template conventions in the wild: structured content parts
  // (SmolVLM, LFM2-VL, Qwen) and an inline "<image>" marker in a plain string
  // (FastVLM — see onnx-community/FastVLM-0.5B-ONNX's own README). N frames
  // means N markers / N image parts, in front of the text either way.
  const messages =
    recipe.chatStyle === "inline-image"
      ? [{ role: "user", content: `<image>`.repeat(images.length) + prompt }]
      : [
          {
            role: "user",
            content: [
              ...images.map(() => ({ type: "image" })),
              { type: "text", text: prompt },
            ],
          },
        ];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  // Argument order differs by family and getting it wrong surfaces as a shape
  // error inside the tokenizer rather than here, so it's carried as data.
  // processorOptions is likewise per-model: `do_image_splitting: false` is the
  // difference between ~2s and ~15s/scan on SmolVLM, and FastVLM needs
  // `add_special_tokens: false` because its template already emits them.
  const opts = recipe.processorOptions || {};
  const inputs =
    recipe.processorArgs === "images-first"
      ? await processor(images, text, opts)
      : await processor(text, images, opts);

  const promptLength = inputs.input_ids.dims.at(-1);
  const base = {
    ...inputs,
    max_new_tokens: maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS,
    // Greedy. A monitor that returns a different verdict for the same frame
    // is unusable, and it makes the eval screen's numbers mean something.
    do_sample: false,
    stopping_criteria: stopping,
  };
  // Greedy decoding on a small model repeats itself (the compact action prompt
  // produced "they're talking to each other." eight times), so the prose legs
  // ask for a repetition penalty. It is applied to generated tokens only — the
  // library's `repetition_penalty` also penalises the prompt, which on the
  // detection leg pushed down YES/NO themselves (see lib/repetition-penalty.js).
  // Deliberately not `no_repeat_ngram_size`, which would forbid the repeated
  // key punctuation the JSON profile legitimately emits.
  //
  // The capture always runs for its first-step timestamp; it copies the
  // vocabulary row (~600 KB at a 150k vocabulary) only for legs that read a
  // confidence (`wantLogits`, i.e. detection).
  const capture = makeLogitCapture({ copyRow: Boolean(wantLogits) });
  const processors = [];
  if (repetitionPenalty > 1) processors.push(generatedRepetitionPenalty(promptLength, repetitionPenalty));
  processors.push(capture.process);
  const options = { ...base, logits_processor: processors };
  const genStart = performance.now();
  const outputIds = await model.generate(options);

  const generatedLength = outputIds.dims?.at(-1) ?? promptLength;
  const decoded = processor.batch_decode(
    outputIds.slice(null, [promptLength, null]),
    { skip_special_tokens: true },
  );
  const end = performance.now();
  const latencyMs = Math.round(end - start);
  // Where the scan's time went. prefillMs covers the vision encoder and the
  // prompt forward pass (up to the first logits); decodeMs is everything
  // after. Null when no step ran (an abort before the first forward).
  const first = capture.state.firstStepAt;
  const timing = {
    preprocessMs: Math.round(genStart - start),
    prefillMs: first != null ? Math.round(first - genStart) : null,
    decodeMs: first != null ? Math.round(end - first) : null,
  };
  const completionTokens = Math.max(0, generatedLength - promptLength);
  const emitted = outputIds?.data
    ? Array.from(outputIds.data).slice(promptLength).map(Number)
    : [];
  // `emitted[0]` is the token the captured row chose, so the alignment
  // verdictStats needs holds by construction. No row means the model was asked
  // for logits it never produced, and null says so instead of inventing a 100.
  const logits = capture.state.row ? verdictStats([capture.state.row], emitted, verdictIds) : null;
  post({
    id,
    type: "result",
    // Echoed so harnesses can tell the three generation legs apart — without
    // it the verdict probe counted one detection as three scans (detect,
    // announce, webhook all arrive as anonymous results).
    purpose: purpose ?? null,
    text: (decoded?.[0] || "").trim(),
    logits: logits ? { ...logits, decodeSteps: capture.state.steps } : null,
    timing,
    usage: {
      prompt_tokens: promptLength,
      completion_tokens: completionTokens,
      total_tokens: promptLength + completionTokens,
    },
    latencyMs,
  });
}

// Flips the interrupt flag so the in-flight generate() loop (if any) stops
// --- Object gate ----------------------------------------------------------

async function handleLoadDetector(id, { model, dtype, device }) {
  if (detector && detector.modelId === model && detector.device === device) {
    post({ id, type: "ready", device: detector.device });
    return;
  }
  await disposeDetector();
  const resolvedDevice =
    device || (typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm");
  // Shares the VLM's device request: useAdapterLimits() is idempotent, and on
  // a gated session the detector is usually what triggers it first.
  await useAdapterLimits(resolvedDevice);
  // No processor. This export's own preprocessor_config.json asks for a
  // stretch-resize and a /255 rescale with no normalization and no padding —
  // three lines of OffscreenCanvas below — so AutoProcessor would only add a
  // Hub round-trip and a YolosImageProcessor whose defaults we'd switch off.
  const model_ = await AutoModel.from_pretrained(model, {
    dtype,
    device: resolvedDevice,
  });
  detector = { modelId: model, device: resolvedDevice, model: model_ };
  post({ id, type: "ready", device: resolvedDevice });
}

// One reusable canvas and one reusable input buffer: the export's spatial dims
// are fixed at 640x640, and reallocating 1.6 MB of pixels twice a second would
// hand the GC work for nothing.
let detectCanvas = null;
let detectCtx = null;
let detectBuffer = null;

async function handleDetect(id, { bitmap, size = 640 }) {
  if (!detector) throw new Error("No detector loaded — send a 'load' message first.");
  const start = performance.now();

  if (!detectCanvas || detectCanvas.width !== size) {
    detectCanvas = new OffscreenCanvas(size, size);
    detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
    detectBuffer = new Float32Array(3 * size * size);
  }
  // Stretch, don't letterbox: the gate only ever compares a frame against
  // other frames from the same camera, so a consistent aspect distortion
  // cancels out — and skipping the pad removes both an un-letterboxing step
  // and a class of off-by-a-pad-offset bugs.
  detectCtx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close?.();
  const { data } = detectCtx.getImageData(0, 0, size, size);

  const plane = size * size;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    detectBuffer[i] = data[p] / 255;
    detectBuffer[plane + i] = data[p + 1] / 255;
    detectBuffer[2 * plane + i] = data[p + 2] / 255;
  }
  const out = await detector.model({
    pixel_values: new Tensor("float32", detectBuffer, [1, 3, size, size]),
  });

  // logits [1, 300, 80] raw (pre-sigmoid) and pred_boxes [1, 300, 4] as
  // normalized cxcywh. Copied out of the session's own buffers before being
  // transferred — what ORT hands back are views the next run may reuse.
  const logits = Float32Array.from(out.logits.data);
  const boxes = Float32Array.from(out.pred_boxes.data);
  post(
    {
      id,
      type: "detections",
      logits,
      logitsDims: out.logits.dims.slice(1),
      boxes,
      boxesDims: out.pred_boxes.dims.slice(1),
      latencyMs: Math.round(performance.now() - start),
    },
    [logits.buffer, boxes.buffer],
  );
}

async function disposeDetector() {
  if (!detector) return;
  const previous = detector;
  detector = null;
  await previous.model?.dispose?.();
}

// within one token. There's only ever one model/stopping-criteria pair
// loaded at a time, so no id matching is needed here.
function handleAbort() {
  current?.stopping.interrupt();
}

async function disposeCurrent(task) {
  if (!current || (task && current.task !== task)) return;
  const previous = current;
  current = null;
  // Transformers.js models own the expensive ONNX sessions. Dispose before
  // another model is allowed to allocate; processors currently may not expose
  // dispose, so make that optional.
  await previous.model?.dispose?.();
  await previous.processor?.dispose?.();
}

async function handleUnload(id, { task }) {
  if (!task || task === "detect") await disposeDetector();
  if (task !== "detect") await disposeCurrent(task);
  post({ id, type: "ready", device: null });
}
