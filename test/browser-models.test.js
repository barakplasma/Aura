import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_MODELS,
  DEFAULT_BROWSER_MODEL,
  FALLBACK_BROWSER_MODEL,
  browserModelKeys,
  getBrowserModel,
  modelUnsupportedReason,
  pickBrowserModel,
  probeBrowserEnv,
} from "../lib/browser-models.js";

test("every row carries the fields the worker and the UI read off it", () => {
  for (const [key, cfg] of Object.entries(BROWSER_MODELS)) {
    assert.ok(cfg.modelId.includes("/"), `${key}: modelId must be owner/repo`);
    assert.ok(cfg.label && cfg.sizeLabel, `${key}: needs a label and size label`);
    assert.ok(Number.isFinite(cfg.downloadBytes) && cfg.downloadBytes > 0, key);
    assert.ok(cfg.dtype && typeof cfg.dtype === "object", `${key}: dtype map`);
    assert.ok(
      ["text-first", "images-first"].includes(cfg.processorArgs),
      `${key}: processorArgs`,
    );
    assert.ok(
      ["content-parts", "inline-image"].includes(cfg.chatStyle),
      `${key}: chatStyle`,
    );
    assert.ok(["json", "compact"].includes(cfg.promptProfile), `${key}: promptProfile`);
  }
});

test("the default and the fallback are both real rows", () => {
  assert.ok(getBrowserModel(DEFAULT_BROWSER_MODEL));
  assert.ok(getBrowserModel(FALLBACK_BROWSER_MODEL));
  // The fallback is the one row that must survive without WebGPU.
  assert.equal(getBrowserModel(FALLBACK_BROWSER_MODEL).requiresWebGpu, false);
});

test("getBrowserModel never throws on unknown input", () => {
  assert.equal(getBrowserModel("nope"), null);
  assert.equal(getBrowserModel(undefined), null);
  assert.equal(getBrowserModel(""), null);
});

test("browserModelKeys is ordered by download size, smallest first", () => {
  const sizes = browserModelKeys().map((k) => BROWSER_MODELS[k].downloadBytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
});

test("pickBrowserModel: no WebGPU means the WASM-viable fallback, whatever the RAM", () => {
  assert.equal(pickBrowserModel({ hasWebGpu: false, deviceMemoryGB: 8 }), FALLBACK_BROWSER_MODEL);
  assert.equal(pickBrowserModel({}), FALLBACK_BROWSER_MODEL);
});

test("pickBrowserModel: a Pixel 10 in Chrome gets the largest auto-selectable row that runs", () => {
  // Chrome caps navigator.deviceMemory at 8 by spec, so a 12-16 GB phone is
  // indistinguishable from an 8 GB one here. 8 must not read as "be careful".
  // Not the DEFAULT any more: the default must be measured-working
  // (smolvlm2-500m), while auto-pick recommends the largest runnable row,
  // which after grey-lining qwen is LFM2.5-VL.
  const pixel10 = { hasWebGpu: true, hasShaderF16: true, deviceMemoryGB: 8, maxBufferBytes: 2 ** 31 - 1 };
  assert.equal(pickBrowserModel(pixel10), "lfm2.5-vl-450m");
  assert.notEqual(DEFAULT_BROWSER_MODEL, FALLBACK_BROWSER_MODEL);
});

test("pickBrowserModel: unknown deviceMemory is treated as comfortable, not as the floor", () => {
  // Firefox and Safari don't implement deviceMemory at all.
  assert.equal(
    pickBrowserModel({ hasWebGpu: true, hasShaderF16: true, maxBufferBytes: 2 ** 31 - 1 }),
    "lfm2.5-vl-450m",
  );
});

test("pickBrowserModel: a small GPU buffer limit rules out the bigger rows", () => {
  assert.equal(
    pickBrowserModel({ hasWebGpu: true, hasShaderF16: true, deviceMemoryGB: 8, maxBufferBytes: 128 * 1024 * 1024 }),
    FALLBACK_BROWSER_MODEL,
  );
});

test("pickBrowserModel: low RAM falls back even with WebGPU", () => {
  assert.equal(
    pickBrowserModel({ hasWebGpu: true, hasShaderF16: true, deviceMemoryGB: 2, maxBufferBytes: 2 ** 31 - 1 }),
    FALLBACK_BROWSER_MODEL,
  );
});

test("pickBrowserModel never returns a row it isn't allowed to auto-select", () => {
  for (const env of [
    { hasWebGpu: true, hasShaderF16: true, deviceMemoryGB: 8, maxBufferBytes: 2 ** 31 - 1 },
    { hasWebGpu: true, hasShaderF16: true, deviceMemoryGB: 64, maxBufferBytes: Number.MAX_SAFE_INTEGER },
    { hasWebGpu: false },
  ]) {
    assert.equal(BROWSER_MODELS[pickBrowserModel(env)].autoSelectable, true);
  }
});

test("probeBrowserEnv reports no WebGPU when navigator has no gpu, or the adapter is refused", async () => {
  assert.deepEqual(await probeBrowserEnv({ deviceMemory: 8 }), {
    hasWebGpu: false,
    deviceMemoryGB: 8,
  });
  assert.deepEqual(
    await probeBrowserEnv({ deviceMemory: 8, gpu: { requestAdapter: async () => null } }),
    { hasWebGpu: false, deviceMemoryGB: 8 },
  );
  assert.deepEqual(
    await probeBrowserEnv({
      gpu: {
        requestAdapter: async () => {
          throw new Error("blocked");
        },
      },
    }),
    { hasWebGpu: false, deviceMemoryGB: undefined },
  );
});

test("probeBrowserEnv reads the adapter's storage-buffer limit", async () => {
  const env = await probeBrowserEnv({
    deviceMemory: 8,
    gpu: {
      requestAdapter: async () => ({ features: new Set(["shader-f16"]), limits: { maxStorageBufferBindingSize: 1024 } }),
    },
  });
  assert.deepEqual(env, { hasWebGpu: true, hasShaderF16: true, deviceMemoryGB: 8, maxBufferBytes: 1024 });
});

test("pickBrowserModel never recommends an fp16 model on an adapter without shader-f16", () => {
  assert.equal(
    pickBrowserModel({ hasWebGpu: true, hasShaderF16: false, deviceMemoryGB: 8, maxBufferBytes: 2 ** 31 - 1 }),
    FALLBACK_BROWSER_MODEL,
  );
});

// --- Qwen3.5 0.8B + SmolVLM2 500M rows ------------------------------------

test("Qwen3.5 0.8B is the new default: official ONNX conversion, auto-selected", () => {
  const cfg = getBrowserModel("qwen3.5-0.8b");
  assert.ok(cfg, "row exists");
  assert.equal(cfg.modelId, "onnx-community/Qwen3.5-0.8B-ONNX");
  assert.equal(cfg.externalData, true, "weights ship as sibling .onnx_data chunks");
  assert.equal(cfg.promptProfile, "json");
  assert.equal(cfg.autoSelectable, true);
  assert.equal(cfg.requiresWebGpu, true);
  // The conversion README's own validated WebGPU recipe (fp16 vision encoder
  // because FastViT-style convs quantize poorly, q4 for the big decoder).
  assert.deepEqual(cfg.dtype, {
    embed_tokens: "q4",
    vision_encoder: "fp16",
    decoder_model_merged: "q4",
  });
});

test("the Qwen3.5 row bounds vision-token compute without distorting the frame", () => {
  // Qwen2VL-style smart resize reads min/max pixels off the image-processor
  // instance at call time, so the recipe caps compute at the capture size
  // (640x480) and never upscales smaller frames — data, not a worker branch.
  const cfg = getBrowserModel("qwen3.5-0.8b");
  assert.deepEqual(cfg.imageProcessorConfig, { min_pixels: 65536, max_pixels: 307200 });
});

test("SmolVLM2 500M is an opt-in row sharing the 256M's calling convention", () => {
  const cfg = getBrowserModel("smolvlm2-500m");
  assert.ok(cfg, "row exists");
  assert.equal(cfg.modelId, "HuggingFaceTB/SmolVLM2-500M-Video-Instruct");
  assert.equal(cfg.processorArgs, "text-first");
  assert.equal(cfg.chatStyle, "content-parts");
  assert.deepEqual(cfg.processorOptions, { do_image_splitting: false });
  // Was "json" on the assumption that 500M follows the schema because 256M
  // cannot. Measured on the Pixel 7a instead: given the schema it emitted
  // `"100"` repeatedly to the token cap, so the compact one-line profile is
  // the one its output actually parses.
  assert.equal(cfg.promptProfile, "compact", "measured: it babbles on the JSON schema");
  assert.equal(cfg.autoSelectable, false, "a deliberate download, like FastVLM");
  assert.equal(cfg.requiresWebGpu, true);
});

test("the auto-pick on a Pixel 10-class device skips the greyed qwen row", () => {
  const pixel10 = { hasWebGpu: true, hasShaderF16: true, deviceMemoryGB: 8, maxBufferBytes: 2 ** 31 - 1 };
  // qwen3.5-0.8b held both titles until the reference phone measured it:
  // a scan never finished and the device crashed (VK_ERROR_DEVICE_LOST in
  // surfaceflinger). The recommendation must track what actually runs.
  assert.equal(modelUnsupportedReason("qwen3.5-0.8b"), "scan never finished on the reference phone — hung WebGPU inference, tab wedged");
  assert.notEqual(pickBrowserModel(pixel10), "qwen3.5-0.8b");
  assert.equal(DEFAULT_BROWSER_MODEL, "smolvlm2-500m");
  // The default itself must always be a selectable row.
  assert.equal(modelUnsupportedReason(DEFAULT_BROWSER_MODEL, { hasWebGpu: true, hasShaderF16: true }), null);
});

test("modelUnsupportedReason names the device gate separately from the catalogue gate", () => {
  // Device lacks shader-f16: every WebGPU row greys for that reason, even
  // rows that are fine on real hardware.
  assert.equal(modelUnsupportedReason("smolvlm2-500m", { hasShaderF16: false }), "requires WebGPU fp16");
  // Device without WebGPU at all.
  assert.equal(modelUnsupportedReason("fastvlm-0.5b", { hasWebGpu: false }), "requires WebGPU fp16");
  // With no gate at all: the 256M row is the no-WebGPU floor.
  assert.equal(modelUnsupportedReason("smolvlm2-256m", {}), null);
  assert.equal(modelUnsupportedReason("no-such-row"), "unknown model");
});
