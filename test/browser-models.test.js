import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_MODELS,
  DEFAULT_BROWSER_MODEL,
  FALLBACK_BROWSER_MODEL,
  browserModelKeys,
  getBrowserModel,
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

test("pickBrowserModel: a Pixel 10 in Chrome gets the instruction-following default", () => {
  // Chrome caps navigator.deviceMemory at 8 by spec, so a 12-16 GB phone is
  // indistinguishable from an 8 GB one here. 8 must not read as "be careful".
  const pixel10 = { hasWebGpu: true, deviceMemoryGB: 8, maxBufferBytes: 2 ** 31 - 1 };
  assert.equal(pickBrowserModel(pixel10), DEFAULT_BROWSER_MODEL);
  assert.notEqual(DEFAULT_BROWSER_MODEL, FALLBACK_BROWSER_MODEL);
});

test("pickBrowserModel: unknown deviceMemory is treated as comfortable, not as the floor", () => {
  // Firefox and Safari don't implement deviceMemory at all.
  assert.equal(
    pickBrowserModel({ hasWebGpu: true, maxBufferBytes: 2 ** 31 - 1 }),
    DEFAULT_BROWSER_MODEL,
  );
});

test("pickBrowserModel: a small GPU buffer limit rules out the bigger rows", () => {
  assert.equal(
    pickBrowserModel({ hasWebGpu: true, deviceMemoryGB: 8, maxBufferBytes: 128 * 1024 * 1024 }),
    FALLBACK_BROWSER_MODEL,
  );
});

test("pickBrowserModel: low RAM falls back even with WebGPU", () => {
  assert.equal(
    pickBrowserModel({ hasWebGpu: true, deviceMemoryGB: 2, maxBufferBytes: 2 ** 31 - 1 }),
    FALLBACK_BROWSER_MODEL,
  );
});

test("pickBrowserModel never returns a row it isn't allowed to auto-select", () => {
  for (const env of [
    { hasWebGpu: true, deviceMemoryGB: 8, maxBufferBytes: 2 ** 31 - 1 },
    { hasWebGpu: true, deviceMemoryGB: 64, maxBufferBytes: Number.MAX_SAFE_INTEGER },
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
      requestAdapter: async () => ({ limits: { maxStorageBufferBindingSize: 1024 } }),
    },
  });
  assert.deepEqual(env, { hasWebGpu: true, deviceMemoryGB: 8, maxBufferBytes: 1024 });
});
