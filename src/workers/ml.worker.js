// Aura ML worker — the ONLY file in this repo that imports
// @huggingface/transformers (see CLAUDE.md's bundle rule: the same one that
// keeps @ax-llm/ax out of the main bundle via a separate dynamic import).
// Runs a small vision-language model (SmolVLM) entirely in this worker so
// the BROWSER engine never touches src/App.jsx's static import graph.
//
// Message protocol (see docs/PRD-browser-engine.md and lib/browser-engine.js,
// the main-thread facade that speaks it):
//   -> { id, type: 'load',   task: 'vlm', model, dtype, device }
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
// Only the 'vlm' task is implemented — a 'clip' task belongs to the separate
// PRD-local-prefilters.md and is out of scope here, but the `task` field
// already exists so adding it later doesn't require a protocol change.

import {
  AutoProcessor,
  AutoModelForVision2Seq,
  RawImage,
  StoppingCriteria,
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

// One model loaded at a time — the app only ever runs one BROWSER-engine
// model concurrently, and holding two in VRAM/RAM would be wasteful.
let current = null; // { task, modelId, device, model, processor, stopping }

self.addEventListener("message", async (event) => {
  const data = event.data || {};
  const { id, type } = data;
  try {
    if (type === "load") await handleLoad(id, data);
    else if (type === "scan") await handleScan(id, data);
    else if (type === "abort") handleAbort(data);
    else if (type === "unload") handleUnload(id, data);
    else post({ id, type: "error", message: `Unknown message type: ${type}` });
  } catch (err) {
    post({ id, type: "error", message: err?.message || String(err) });
  }
});

function post(msg) {
  self.postMessage(msg);
}

async function handleLoad(id, { task, model, dtype, device }) {
  if (task !== "vlm") throw new Error(`Unsupported task: ${task}`);

  // Already loaded with the same model + device — nothing to do.
  if (current && current.modelId === model && current.device === device) {
    post({ id, type: "ready", device: current.device });
    return;
  }
  // Swapping models: drop the old one first so it can be garbage collected
  // before the new one starts allocating.
  current = null;

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

  const processor = await AutoProcessor.from_pretrained(model, { progress_callback });
  const vlm = await AutoModelForVision2Seq.from_pretrained(model, {
    dtype,
    device: resolvedDevice,
    progress_callback,
  });

  current = {
    task,
    modelId: model,
    device: resolvedDevice,
    model: vlm,
    processor,
    stopping: new InterruptableStoppingCriteria(),
  };
  post({ id, type: "ready", device: resolvedDevice });
}

async function handleScan(id, { prompt, imageDataUrl, maxNewTokens }) {
  if (!current) throw new Error("No model loaded — send a 'load' message first.");
  const { model, processor, stopping } = current;
  stopping.reset();
  const start = performance.now();

  const image = await RawImage.fromURL(imageDataUrl);
  const messages = [
    { role: "user", content: [{ type: "image" }, { type: "text", text: prompt }] },
  ];
  const text = processor.apply_chat_template(messages, { add_generation_prompt: true });
  // do_image_splitting: false — SmolVLM's default splits the frame into up
  // to a dozen crops, multiplying vision-encoder work for no benefit at
  // 640x480. This single flag is the difference between ~2s and ~15s/scan.
  const inputs = await processor(text, [image], { do_image_splitting: false });

  const promptLength = inputs.input_ids.dims.at(-1);
  const outputIds = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens ?? DEFAULT_MAX_NEW_TOKENS,
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

// Flips the interrupt flag so the in-flight generate() loop (if any) stops
// within one token. There's only ever one model/stopping-criteria pair
// loaded at a time, so no id matching is needed here.
function handleAbort() {
  current?.stopping.interrupt();
}

function handleUnload(id, { task }) {
  if (current && (!task || current.task === task)) current = null;
  post({ id, type: "ready", device: null });
}
