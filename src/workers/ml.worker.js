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
//   <- { id, type: 'ready',  device: 'webgpu' | 'wasm' }
//   -> { id, type: 'scan',   prompt, imageDataUrl, maxNewTokens }
//   <- { id, type: 'result', text, usage, latencyMs }
//   -> { id, type: 'abort' }                                 (stop mid-generate)
//   -> { id, type: 'unload', task }
//   <- { id, type: 'error',  message }
//
// And the object gate (see docs/PRD-object-gate.md), which shares this worker
// rather than spawning a second one — one ORT instance, one WebGPU device,
// one adapter-limits call, one cache bucket:
//   -> { id, type: 'load',   task: 'detect', model, dtype, device }
//   -> { id, type: 'detect', bitmap, size }   (bitmap is transferred)
//   <- { id, type: 'detections', logits, logitsDims, boxes, boxesDims, latencyMs }
// The two raw tensors go back to the main thread untouched: decoding them is
// pure arithmetic and lives in lib/object-gate.js, where it is testable.
//
// Models are held per task, so the VLM and the detector coexist — a detector
// is single-digit megabytes next to an 810 MB VLM.

import {
  AutoProcessor,
  AutoModel,
  AutoModelForImageTextToText,
  RawImage,
  StoppingCriteria,
  Tensor,
  env,
} from "@huggingface/transformers";
import { fetchModelSizeEstimate } from "../../lib/model-size.js";
import { createProgressState, recordProgress, aggregateProgress } from "../../lib/download-progress.js";

// Point ONNX Runtime Web at same-origin WASM files instead of its default
// CDN, so the browser engine works offline once cached (see
// scripts/build-react.js, which copies these from
// node_modules/onnxruntime-web/dist into public/ort/, and
// scripts/sw-template.js's runtime cache rule for ort/). `.href` matters:
// onnxruntime-web only treats wasmPaths as a directory prefix when it's a
// plain string, not a URL object.
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

const DEFAULT_MAX_NEW_TOKENS = 48;

// --- WebGPU device limits -------------------------------------------------

// ORT creates its WebGPU device with the spec's *minimum* limits — notably a
// 128 MB maxStorageBufferBindingSize — regardless of what the GPU can
// actually do, and transformers.js doesn't intervene: it calls
// requestAdapter() only to probe fp16 support (its src/utils/dtypes.js), and
// otherwise sets nothing but powerPreference. A model with a buffer over that
// limit fails session creation and drops to WASM, which at 10-30s/scan reads
// as "WebGPU isn't supported here" rather than as a ceiling that could have
// been raised. Android adapters report smaller limits than desktop ones, so
// this bites hardest on exactly the hardware the BROWSER engine targets.
//
// media-clusterer hit this first, against a 228 MB model — see its
// src/sapiens2.ts, which this is a port of. The fix is to request a device
// with the adapter's own limits and hand it to ORT before the first session.
//
// Entirely best-effort, and run at most once: every failure path leaves ORT
// to create its own device exactly as it does today, so the worst case is
// current behaviour. Note that *reading* env.backends.onnx.webgpu.device
// before the first session is itself a device-creating side effect, so the
// "already done" check is a local flag rather than a read of that property.
let adapterLimitsApplied = false;

async function useAdapterLimits() {
  if (adapterLimitsApplied || typeof navigator === "undefined" || !navigator.gpu) return;
  adapterLimitsApplied = true;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter?.limits) return;
    // A storage binding is capped by both of these, so raising one alone
    // still leaves the other at the spec minimum.
    const { maxStorageBufferBindingSize, maxBufferSize } = adapter.limits;
    const requiredLimits = {};
    if (maxStorageBufferBindingSize) requiredLimits.maxStorageBufferBindingSize = maxStorageBufferBindingSize;
    if (maxBufferSize) requiredLimits.maxBufferSize = maxBufferSize;
    const device = await adapter.requestDevice({ requiredLimits });
    if (device) env.backends.onnx.webgpu.device = device;
  } catch {
    // No adapter, limits refused, or ORT already holds a device — in every
    // case ORT's own default device is still perfectly usable.
  }
}

// One model per task. 'vlm' holds the vision-language model the scan loop
// runs; 'detect' holds the object-gate detector. Only ever one of each — the
// app never runs two VLMs concurrently, and holding two in VRAM would be
// wasteful.
const slots = { vlm: null, detect: null };

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  const { id, type } = data;
  try {
    if (type === "load") await handleLoad(id, data);
    else if (type === "scan") await handleScan(id, data);
    else if (type === "detect") await handleDetect(id, data);
    else if (type === "abort") handleAbort(data);
    else if (type === "unload") handleUnload(id, data);
    else post({ id, type: "error", message: `Unknown message type: ${type}` });
  } catch (err) {
    post({ id, type: "error", message: err?.message || String(err) });
  }
});

function post(msg, transfer) {
  if (transfer) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

async function handleLoad(id, { task, model, dtype, device, recipe }) {
  if (task !== "vlm" && task !== "detect")
    throw new Error(`Unsupported task: ${task}`);

  // Already loaded with the same model + device — nothing to do.
  const held = slots[task];
  if (held && held.modelId === model && held.device === device) {
    post({ id, type: "ready", device: held.device });
    return;
  }
  // Swapping models: drop the old one first so it can be garbage collected
  // before the new one starts allocating.
  slots[task] = null;

  const resolvedDevice =
    device || (typeof navigator !== "undefined" && navigator.gpu ? "webgpu" : "wasm");

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

  // Must happen before the first WebGPU session is created, which the model
  // load below is.
  if (resolvedDevice === "webgpu") await useAdapterLimits();

  if (task === "detect") {
    // No processor: the detector's preprocessing is a stretch-resize to
    // 640x640 and a /255 rescale (per the export's own preprocessor_config),
    // which an OffscreenCanvas does in three lines — see handleDetect(). Going
    // through AutoProcessor would add a Hub round-trip and a YolosImageProcessor
    // whose padding/normalization defaults we'd only have to switch back off.
    const detector = await AutoModel.from_pretrained(model, {
      dtype,
      device: resolvedDevice,
      progress_callback,
    });
    slots.detect = {
      task,
      modelId: model,
      device: resolvedDevice,
      model: detector,
    };
    post({ id, type: "ready", device: resolvedDevice });
    return;
  }

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

  slots.vlm = {
    task,
    modelId: model,
    device: resolvedDevice,
    model: vlm,
    processor,
    recipe: recipe || {},
    stopping: new InterruptableStoppingCriteria(),
  };
  post({ id, type: "ready", device: resolvedDevice });
}

async function handleScan(id, { prompt, imageDataUrl, maxNewTokens }) {
  if (!slots.vlm) throw new Error("No model loaded — send a 'load' message first.");
  const { model, processor, recipe, stopping } = slots.vlm;
  stopping.reset();
  const start = performance.now();

  const image = await RawImage.fromURL(imageDataUrl);
  // Two chat-template conventions in the wild: structured content parts
  // (SmolVLM, LFM2-VL) and an inline "<image>" marker in a plain string
  // (FastVLM — see onnx-community/FastVLM-0.5B-ONNX's own README).
  const messages =
    recipe.chatStyle === "inline-image"
      ? [{ role: "user", content: `<image>${prompt}` }]
      : [{ role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] }];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  // Argument order differs by family and getting it wrong surfaces as a shape
  // error inside the tokenizer rather than here, so it's carried as data.
  // processorOptions is likewise per-model: `do_image_splitting: false` is the
  // difference between ~2s and ~15s/scan on SmolVLM, and FastVLM needs
  // `add_special_tokens: false` because its template already emits them.
  const opts = recipe.processorOptions || {};
  const inputs =
    recipe.processorArgs === "images-first"
      ? await processor(image, text, opts)
      : await processor(text, [image], opts);

  const promptLength = inputs.input_ids.dims.at(-1);
  const outputIds = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS,
    // Greedy. A monitor that returns a different verdict for the same frame
    // is unusable, and it makes the eval screen's numbers mean something.
    do_sample: false,
    stopping_criteria: stopping,
  });

  const generatedLength = outputIds.dims?.at(-1) ?? promptLength;
  const decoded = processor.batch_decode(
    outputIds.slice(null, [promptLength, null]),
    { skip_special_tokens: true },
  );
  const latencyMs = Math.round(performance.now() - start);
  const completionTokens = Math.max(0, generatedLength - promptLength);
  post({
    id,
    type: "result",
    text: (decoded?.[0] || "").trim(),
    usage: {
      prompt_tokens: promptLength,
      completion_tokens: completionTokens,
      total_tokens: promptLength + completionTokens,
    },
    latencyMs,
  });
}

// --- Object gate ----------------------------------------------------------

// One reusable canvas for the detector's input. The export's spatial dims are
// fixed at 640x640, so this never needs resizing, and reallocating it on every
// tick would hand the GC 1.6 MB of pixels twice a second.
let detectCanvas = null;
let detectCtx = null;
let detectBuffer = null;

async function handleDetect(id, { bitmap, size = 640 }) {
  const held = slots.detect;
  if (!held) throw new Error("No detector loaded — send a 'load' message first.");
  const start = performance.now();

  if (!detectCanvas || detectCanvas.width !== size) {
    detectCanvas = new OffscreenCanvas(size, size);
    detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
    detectBuffer = new Float32Array(3 * size * size);
  }
  // Stretch, don't letterbox. The gate only ever compares a frame against
  // other frames from the same camera, so a consistent aspect distortion
  // cancels out — and skipping the pad removes both an un-letterboxing step
  // and a class of off-by-a-pad-offset bugs.
  detectCtx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close?.();
  const { data } = detectCtx.getImageData(0, 0, size, size);

  // RGBA bytes → NCHW float32, rescaled by 1/255. That is the whole of this
  // export's preprocessing: its preprocessor_config.json sets do_normalize
  // false and do_pad false, so there is no mean/std step to get wrong.
  const plane = size * size;
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    detectBuffer[i] = data[p] / 255;
    detectBuffer[plane + i] = data[p + 1] / 255;
    detectBuffer[2 * plane + i] = data[p + 2] / 255;
  }
  const pixel_values = new Tensor("float32", detectBuffer, [1, 3, size, size]);
  const out = await held.model({ pixel_values });

  // logits [1, 300, 80] raw (pre-sigmoid) and pred_boxes [1, 300, 4] as
  // normalized cxcywh. Copied out of the session's own buffers before they are
  // transferred — the arrays ORT hands back are views the next run may reuse.
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

// Flips the interrupt flag so the in-flight generate() loop (if any) stops
// within one token. There's only ever one model/stopping-criteria pair
// loaded at a time, so no id matching is needed here.
function handleAbort() {
  slots.vlm?.stopping.interrupt();
}

function handleUnload(id, { task }) {
  if (!task) {
    slots.vlm = null;
    slots.detect = null;
  } else if (slots[task]) {
    slots[task] = null;
  }
  post({ id, type: "ready", device: null });
}
