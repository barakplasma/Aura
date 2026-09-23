// Aura BROWSER-engine model table.
//
// The model is *data*, not control flow. Adding a fourth in-browser VLM is a
// new row here, not another `if (modelId.includes('smolvlm'))` branch in
// src/workers/ml.worker.js. Everything that needs to know "which repo, how
// quantised, how do I talk to its processor, can it follow a JSON prompt"
// reads it off the descriptor. (Same idea as media-clusterer's
// src/vlmTiers.ts, which this is modelled on.)
//
// Kept in its own module rather than inside browser-engine.js so it — and
// pickBrowserModel() below — are unit-testable under `node --test` without
// touching Worker, navigator or the DOM.

// How the model's processor wants to be called. transformers.js is not
// consistent here and getting it wrong produces a confusing shape error deep
// inside the tokenizer rather than at the call site:
//   'text-first'   processor(text, [image], opts)   — Idefics3/SmolVLM
//   'images-first' processor(image, text, opts)     — Lfm2Vl, LlavaQwen2
const TEXT_FIRST = "text-first";
const IMAGES_FIRST = "images-first";

// How the prompt reaches the chat template.
//   'content-parts'  [{ role, content: [{type:'image'}, {type:'text', text}] }]
//   'inline-image'   [{ role, content: '<image>' + text }]  — FastVLM's own
//                    README uses this; its template takes a plain string.
const CONTENT_PARTS = "content-parts";
const INLINE_IMAGE = "inline-image";

export const BROWSER_MODELS = {
  // --- Default -----------------------------------------------------------
  // Qwen3.5-0.8B: natively multimodal (early-fusion vision + a hybrid
  // Gated-DeltaNet/MoE decoder), so its per-scan cost barely grows with the
  // ~600-token vision prefix — linear attention, not quadratic. This is the
  // official onnx-community conversion of Qwen/Qwen3.5-0.8B, whose README
  // ships exactly this transformers.js recipe; transformers.js 4.2 resolves
  // its `qwen3_5` model_type through AutoModelForImageTextToText, so the
  // worker needs no Qwen-specific branch.
  //
  // The dtype split is the README's validated WebGPU one: q4 for the two big
  // components (decoder ≈ 485 MB, 248k-vocab embed ≈ 163 MB), fp16 for the
  // vision encoder, whose convolutions quantize as poorly as FastVLM's.
  // Weights live in sibling `.onnx_data` chunks — declared by the repo's own
  // config.json (transformers.js_config.use_external_data_format), and
  // lib/model-size.js counts them, so no flag is needed here.
  //
  // transformers.js_config also declares kv_cache_dtype for q4f16/fp16, which
  // the library reads itself.
  "qwen3.5-0.8b": {
    modelId: "onnx-community/Qwen3.5-0.8B-ONNX",
    label: "Qwen3.5 0.8B",
    // Measured on the reference phone (Pixel 7a, Chrome 153, WebGPU, weights
    // fully downloaded): armed on this row the first detection scan never
    // returned — DETECTING for 20+ minutes on a model that should scan in
    // ~2-3 min — the sustained inference wedged the whole tab's devtools
    // endpoint until Chrome was force-restarted, and the phone itself later
    // crashed and rebooted with surfaceflinger dead on VK_ERROR_DEVICE_LOST
    // while this model's session was the only GPU load. That is not "slow",
    // it is "does not finish and takes the device down", which greys it out
    // until someone reproduces a run that completes.
    unsupportedReason:
      "scan never finished on the reference phone — hung WebGPU inference, tab wedged",
    sizeLabel: "~875 MB",
    downloadBytes: 875e6,
    dtype: {
      embed_tokens: "q4",
      vision_encoder: "fp16",
      decoder_model_merged: "q4",
    },
    processorArgs: TEXT_FIRST,
    chatStyle: CONTENT_PARTS,
    // Qwen's image processor smart-resizes to an area window read off the
    // processor instance at call time (min_pixels/max_pixels). Left alone the
    // window is 64k–16.7M pixels, i.e. unbounded; pinning it to the capture
    // size keeps every scan at 640×480 compute with no upscaling of smaller
    // frames — and unlike the README's .resize(448, 448) it never distorts
    // the aspect ratio. imageProcessorConfig exists precisely because these
    // are instance properties, not per-call kwargs.
    imageProcessorConfig: { min_pixels: 65536, max_pixels: 307200 },
    // Non-thinking mode is this model's default — no <think> budget eaten,
    // and stripThinkBlocks in lib/monitor.js backs the parsers up anyway.
    processorOptions: {},
    externalData: true,
    promptProfile: "json",
    // The strongest row in the table and the point of this model — a device
    // that can run LFM2.5 can run this.
    autoSelectable: true,
    minDeviceMemoryGB: 4,
    requiresWebGpu: true,
  },

  // --- Auto-selected alternative (the default until Qwen3.5) -------------
  // LiquidAI's own ONNX export, with their own WebGPU recipe (the README's
  // "Recommended Variants" table: fp16 vision encoder + q4 decoder; q8 is not
  // supported on WebGPU and embed_tokens ships only fp32/fp16). A 350M LFM2
  // decoder actually follows an instruction, which a 256M SmolVLM2 does not —
  // that is the entire reason this row exists.
  "lfm2.5-vl-450m": {
    modelId: "LiquidAI/LFM2.5-VL-450M-ONNX",
    label: "LFM2.5-VL 450M",
    sizeLabel: "~810 MB",
    downloadBytes: 810e6,
    dtype: {
      embed_tokens: "fp16",
      vision_encoder: "fp16",
      decoder_model_merged: "q4",
    },
    processorArgs: IMAGES_FIRST,
    chatStyle: CONTENT_PARTS,
    // The config ships do_image_splitting: true with max_tiles 10 — at 640x480
    // that is up to ten tiles plus a thumbnail through the vision encoder for
    // no gain. The LFM2-VL image processor reads the flag off its own config
    // rather than from per-call kwargs (image_processing_lfm2_vl.js `_call`
    // takes only return_row_col_info), so the worker has to set the property.
    imageProcessorConfig: { do_image_splitting: false },
    processorOptions: {},
    // Weights live in sibling `.onnx_data` files. No option needed here — the
    // repo's own config.json declares transformers.js_config
    // .use_external_data_format — but lib/model-size.js has to count them or
    // the download bar sizes an 810 MB model at under a megabyte.
    externalData: true,
    // Strong enough for buildDetectionPrompt()/buildActionPrompt()'s JSON
    // schema. parseLooseDetection() still backs it up.
    promptProfile: "json",
    // Auto-selected by pickBrowserModel() when the device can take it.
    autoSelectable: true,
    minDeviceMemoryGB: 4,
    requiresWebGpu: true,
  },

  // --- Opt-in alternatives ------------------------------------------------

  // SmolVLM2 500M Video-Instruct — the 256M fallback's bigger sibling, with
  // the ONNX export already in the upstream repo and the exact same calling
  // convention as that row (text-first processor, content-parts chat,
  // do_image_splitting off). The "Video" in the name is the SmolVLM2 family's
  // temporal training, not a transformers.js capability: the worker still
  // feeds one frame per scan. Bigger than 256M and better at describing a
  // scene, but still not reliable at *format* — see promptProfile. Deliberately
  // not auto-selected — eval screen first.
  "smolvlm2-500m": {
    modelId: "HuggingFaceTB/SmolVLM2-500M-Video-Instruct",
    label: "SmolVLM2 500M",
    sizeLabel: "~395 MB",
    downloadBytes: 395e6,
    dtype: {
      embed_tokens: "fp16",
      vision_encoder: "q4",
      decoder_model_merged: "q4",
    },
    processorArgs: TEXT_FIRST,
    chatStyle: CONTENT_PARTS,
    imageProcessorConfig: null,
    processorOptions: { do_image_splitting: false },
    externalData: false,
    // Measured on the reference phone (Pixel 7a, Chrome 153, WebGPU granted
    // 2048 MB buffers): handed buildDetectionPrompt()'s ten-line JSON schema
    // this model generated `"100"` over and over until the token cap — it
    // latched onto the schema's confidence number and ignored the structure.
    // parseLooseDetection() therefore fell through to its fallback on every
    // scan (reason "Nothing notable in view.", confidence 0) and no alert
    // could fire, at ~37 s a scan for the privilege. The one-line form below
    // is the same guard the 256M row exists for; size buys description, not
    // format compliance.
    promptProfile: "compact",
    autoSelectable: false,
    minDeviceMemoryGB: 4,
    requiresWebGpu: true,
  },

  // Apple's FastVLM, whose entire design goal is time-to-first-token on live
  // video — which is exactly Aura's workload. Qwen2-0.5B-Instruct decoder, so
  // instruction-following is comfortable. Not auto-selected only because of
  // the download: this is the dtype recipe from onnx-community's own README
  // and the apple/fastvlm-webgpu demo, and vision_encoder_q4 is a no-op
  // quantization (505 MB, same as fp32 — FastViTHD's convolutions don't
  // quantize). A q4f16-everything variant would be ~820 MB but is not a
  // recipe anyone has validated, and shipping an unvalidated one under a
  // label promising Apple's demo behaviour would be worse than the megabytes.
  "fastvlm-0.5b": {
    modelId: "onnx-community/FastVLM-0.5B-ONNX",
    label: "FastVLM 0.5B",
    sizeLabel: "~1.1 GB",
    downloadBytes: 1110e6,
    dtype: {
      embed_tokens: "fp16",
      vision_encoder: "q4",
      decoder_model_merged: "q4",
    },
    processorArgs: IMAGES_FIRST,
    chatStyle: INLINE_IMAGE,
    imageProcessorConfig: null,
    // Per the README: the chat template already emits the special tokens, so
    // letting the tokenizer add its own duplicates them.
    processorOptions: { add_special_tokens: false },
    externalData: false,
    promptProfile: "json",
    autoSelectable: false,
    minDeviceMemoryGB: 6,
    requiresWebGpu: true,
  },

  // --- Candidate (not yet device-verified) --------------------------------
  // nanoLLaVA-1.5: 0.36B total (SigLIP-400M vision + Qwen2-258M decoder) —
  // the smallest chat-style VLM with a full official onnx-community export
  // (image-text-to-text pipeline tag, complete q4/q4f16 matrix). Offline
  // probe 2026-09-23: tokenizer loads under transformers.js 4.3 and resolves
  // single-token YES=14004 / NO=8996 (Qwen2 vocabulary, shared with
  // FastVLM's decoder), so the YES-vs-NO logit margin works for it. It is a
  // LLaVA-family model, so the processor and chat conventions are the
  // FastVLM/Lfm2Vl pattern. NOT auto-selectable until a phone run proves it
  // finishes inside the 60 s budget; SigLIP-400M is the same size class of
  // vision tower that makes SmolVLM2 500M a ~62 s scan, so this row's
  // viability is exactly what the ladder has to decide.
  "nanollava-1.5": {
    modelId: "onnx-community/nanoLLaVA-1.5",
    label: "nanoLLaVA 1.5",
    sizeLabel: "~875 MB",
    downloadBytes: 876e6,
    dtype: {
      embed_tokens: "fp16",
      vision_encoder: "q4",
      decoder_model_merged: "q4",
    },
    processorArgs: IMAGES_FIRST,
    chatStyle: CONTENT_PARTS,
    imageProcessorConfig: null,
    processorOptions: {},
    externalData: false,
    // 258M decoder: same size class as SmolVLM2's, which measurably cannot
    // follow the JSON schema — assume the compact profile until it proves
    // otherwise on the eval screen.
    promptProfile: "compact",
    autoSelectable: false,
    minDeviceMemoryGB: 4,
    requiresWebGpu: true,
  },

  // --- Fallback -----------------------------------------------------------
  // Kept as the no-WebGPU / low-memory floor, not as a recommendation. At
  // 256M it is a coarse yes/no detector that paraphrases any instruction you
  // give it, which is why it gets the compact prompt profile and why it is no
  // longer the default. The dtype split is Hugging Face's own WebGPU demo
  // recipe for SmolVLM.
  "smolvlm2-256m": {
    modelId: "HuggingFaceTB/SmolVLM2-256M-Video-Instruct",
    label: "SmolVLM2 256M",
    sizeLabel: "~208 MB",
    downloadBytes: 208e6,
    dtype: {
      embed_tokens: "fp16",
      vision_encoder: "q4",
      decoder_model_merged: "q4",
    },
    processorArgs: TEXT_FIRST,
    chatStyle: CONTENT_PARTS,
    imageProcessorConfig: null,
    // SmolVLM's default splits the frame into up to a dozen crops. This one
    // flag is the difference between ~2s and ~15s per scan at 640x480.
    processorOptions: { do_image_splitting: false },
    externalData: false,
    promptProfile: "compact",
    autoSelectable: true,
    minDeviceMemoryGB: 0,
    requiresWebGpu: false,
  },
};

// The default is a model a visitor can actually run. qwen3.5-0.8b held this
// spot until the reference phone proved it cannot finish a scan and takes the
// device down trying; smolvlm2-500m is the only row with a verified complete
// alert cycle (detect → announce → webhook fired, 2026-09-23 session).
export const DEFAULT_BROWSER_MODEL = "smolvlm2-500m";

// The model to fall back to when nothing else fits — the only row with a
// tolerable cadence on the WASM backend.
export const FALLBACK_BROWSER_MODEL = "smolvlm2-256m";

/** Model keys, ascending by download size. */
export function browserModelKeys() {
  return Object.keys(BROWSER_MODELS).sort(
    (a, b) => BROWSER_MODELS[a].downloadBytes - BROWSER_MODELS[b].downloadBytes,
  );
}

/** Descriptor for a key, or null. Never throws on unknown input. */
export function getBrowserModel(key) {
  return BROWSER_MODELS[key] ?? null;
}

/**
 * Why a model is greyed out on this device, or null when it is selectable.
 * Two independent gates: a catalogue-level verdict from real measurements
 * (`unsupportedReason` on the row — "does not finish on the reference phone")
 * and a device-level one (needs WebGPU fp16 that this adapter lacks). The
 * picker greys and names both; auto-pick consults only this function so the
 * two paths can never disagree about what is offered.
 */
export function modelUnsupportedReason(key, env = {}) {
  const cfg = BROWSER_MODELS[key];
  if (!cfg) return "unknown model";
  if (cfg.unsupportedReason) return cfg.unsupportedReason;
  if (cfg.requiresWebGpu && (env.hasWebGpu === false || env.hasShaderF16 === false))
    return "requires WebGPU fp16";
  return null;
}

/**
 * Pick the largest model this device can actually run.
 *
 * Reference device is a Pixel 10 in Chrome: WebGPU on, plenty of RAM. Two
 * things about that device drive the thresholds here, and both are easy to
 * get wrong:
 *
 *  - `navigator.deviceMemory` is **capped at 8** by the spec, so a 12 or
 *    16 GB phone reports the same 8 as a mid-range laptop. 8 therefore has to
 *    read as "comfortable", never as a ceiling to be cautious about.
 *  - Android GPUs report far smaller WebGPU buffer limits than desktop ones,
 *    and ORT allocates each ONNX initializer into a GPU buffer. A model whose
 *    largest weight file exceeds `maxStorageBufferBindingSize` fails at
 *    session creation, so that limit — not RAM — is the real constraint.
 *
 * `env` is injected rather than read off globals so this is testable; every
 * field is optional and an absent one is treated optimistically for memory
 * (phones under-report) and pessimistically for WebGPU (absent means absent).
 */
export function pickBrowserModel(env = {}) {
  const {
    hasWebGpu = false,
    hasShaderF16 = false,
    deviceMemoryGB,
    maxBufferBytes,
  } = env;

  if (!hasWebGpu) return FALLBACK_BROWSER_MODEL;

  // Unknown memory is treated as 8: Firefox and Safari don't implement
  // deviceMemory at all, and assuming the floor there would hand every
  // non-Chrome browser the 256M model regardless of hardware.
  const memGB = Number.isFinite(deviceMemoryGB) ? deviceMemoryGB : 8;

  const candidates = browserModelKeys()
    .map((key) => [key, BROWSER_MODELS[key]])
    // A row with a measured "does not finish" verdict is never recommended,
    // no matter what the hardware probe says — the hardware check answers
    // "can this device hold it", not "does it work".
    .filter(([, cfg]) => !cfg.unsupportedReason)
    .filter(([, cfg]) => cfg.autoSelectable)
    // Every currently advertised large VLM has at least one fp16 component.
    // An adapter without shader-f16 is not an eligible WebGPU target for it;
    // recommending it would only defer this failure until download/load.
    .filter(([, cfg]) => !cfg.requiresWebGpu || hasShaderF16)
    .filter(([, cfg]) => memGB >= cfg.minDeviceMemoryGB)
    // Largest single weight file must fit one GPU buffer. Unknown limit means
    // the caller couldn't probe an adapter, so don't hold it against the model.
    .filter(
      ([, cfg]) =>
        !Number.isFinite(maxBufferBytes) ||
        maxBufferBytes >= largestWeightBytes(cfg),
    );

  if (candidates.length === 0) return FALLBACK_BROWSER_MODEL;
  // Biggest that fits — a bigger model is the whole point of picking at all.
  return candidates[candidates.length - 1][0];
}

// Rough size of the single largest ONNX weight file for a model, used only as
// the GPU-buffer feasibility check above. Deliberately a stored approximation
// rather than a Hub lookup: pickBrowserModel() runs before any network call,
// and being off by a few percent cannot change which side of a 128 MB vs
// 2 GB adapter limit a model lands on.
function largestWeightBytes(cfg) {
  // Decoder weights dominate every row in the table.
  return cfg.downloadBytes * 0.6;
}

/**
 * Probe the running browser for pickBrowserModel()'s input.
 *
 * Async because `navigator.gpu.requestAdapter()` is the only way to see the
 * buffer limits. Never throws — a browser that rejects the adapter request
 * reports "no WebGPU", which is the correct conclusion anyway.
 */
export async function probeBrowserEnv(nav = typeof navigator !== "undefined" ? navigator : null) {
  const deviceMemoryGB = Number.isFinite(nav?.deviceMemory) ? nav.deviceMemory : undefined;
  if (!nav?.gpu) return { hasWebGpu: false, deviceMemoryGB };
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (!adapter) return { hasWebGpu: false, deviceMemoryGB };
    return {
      hasWebGpu: true,
      hasShaderF16: adapter.features?.has("shader-f16") === true,
      deviceMemoryGB,
      maxBufferBytes: adapter.limits?.maxStorageBufferBindingSize,
    };
  } catch {
    return { hasWebGpu: false, deviceMemoryGB };
  }
}
