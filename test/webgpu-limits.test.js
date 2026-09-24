import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deviceRequest,
  limitReport,
  fitsStorageBuffer,
} from "../lib/webgpu-limits.js";
import { BROWSER_MODELS } from "../lib/browser-models.js";

// The Pixel 7a (Chrome 153) measured over CDP: a generous adapter and the
// spec-minimum device ORT creates when nobody asks for more.
const PIXEL7A_ADAPTER = {
  limits: {
    maxStorageBufferBindingSize: 2147483644, // 2 GiB
    maxBufferSize: 4294967292, // 4 GiB
    maxComputeInvocationsPerWorkgroup: 256,
  },
  features: new Set(["shader-f16", "subgroups", "timestamp-query"]),
};

const SPEC_MINIMUM_DEVICE = {
  limits: { maxStorageBufferBindingSize: 134217728, maxBufferSize: 268435456 },
  features: new Set(["shader-f16"]),
};

test("deviceRequest raises the buffer limits to what the adapter allows", () => {
  const req = deviceRequest(PIXEL7A_ADAPTER);
  assert.equal(
    req.requiredLimits.maxStorageBufferBindingSize,
    2147483644,
    "the binding ceiling is the whole reason this module exists",
  );
  assert.equal(req.requiredLimits.maxBufferSize, 4294967292);
});

// GPUSupportedLimits exposes its values as prototype accessors, so
// Object.keys() is empty even though every value reads fine through property
// access. A helper that copies with Object.keys requests nothing, and the
// device silently comes back at the 128 MiB default — which looks like
// success from the caller's side.
test("deviceRequest sees limits that only exist on the prototype", () => {
  class GpuSupportedLimits {
    get maxStorageBufferBindingSize() { return 2147483644; }
    get maxBufferSize() { return 4294967292; }
    get maxBindGroups() { return 8; }
  }
  const limits = new GpuSupportedLimits();
  assert.deepEqual(Object.keys(limits), [], "the trap: own-enumerable enumeration finds nothing");
  const req = deviceRequest({ limits, features: new Set(["shader-f16"]) });
  assert.equal(req.requiredLimits.maxStorageBufferBindingSize, 2147483644);
  assert.equal(req.requiredLimits.maxBufferSize, 4294967292);
});

test("deviceRequest asks for shader-f16 only when the adapter offers it", () => {
  assert.deepEqual(deviceRequest(PIXEL7A_ADAPTER).requiredFeatures, ["shader-f16"]);
  const noFp16 = { ...PIXEL7A_ADAPTER, features: new Set(["subgroups"]) };
  assert.deepEqual(
    deviceRequest(noFp16).requiredFeatures,
    [],
    "demanding an unsupported feature makes requestDevice() throw and would kill the load",
  );
});

test("deviceRequest ignores limits the platform did not report", () => {
  const req = deviceRequest({
    limits: { maxStorageBufferBindingSize: 2147483644, maxBufferSize: Number.NaN },
    features: new Set(),
  });
  assert.deepEqual(req.requiredLimits, { maxStorageBufferBindingSize: 2147483644 });
  assert.equal(
    deviceRequest({ limits: { maxStorageBufferBindingSize: 0 }, features: new Set() }),
    null,
  );
});

test("deviceRequest returns null when there is nothing to request", () => {
  assert.equal(deviceRequest(null), null);
  assert.equal(deviceRequest({}), null);
  assert.equal(deviceRequest({ limits: {}, features: new Set() }), null);
});

test("limitReport answers the WebGPU-or-WASM question in megabytes", () => {
  assert.deepEqual(limitReport(SPEC_MINIMUM_DEVICE), {
    maxStorageBufferMB: 128,
    maxBufferMB: 256,
    adapterMaxStorageBufferMB: null,
    shaderF16: true,
  });
  assert.equal(limitReport(null), null);
  assert.equal(
    limitReport({ limits: {}, features: new Set() }).maxStorageBufferMB,
    null,
    "an unreported ceiling must not read as a number",
  );
});

// A driver may hand back far less than the adapter offered, and a Worker can
// be given a different adapter than its page. Only the pair distinguishes a
// clamp from an under-asked request, and the UI words them differently.
test("limitReport names the ceiling that was asked for as well as the one granted", () => {
  const report = limitReport(SPEC_MINIMUM_DEVICE, PIXEL7A_ADAPTER);
  assert.equal(report.maxStorageBufferMB, 128);
  assert.equal(report.adapterMaxStorageBufferMB, 2048, "2147483644 B rounds to 2048 MB");
});

test("the spec-minimum device cannot bind the default model's decoder", () => {
  const qwen = BROWSER_MODELS["qwen3.5-0.8b"];
  const largest = qwen.downloadBytes * 0.6; // the approximation lib/browser-models.js uses
  assert.equal(
    fitsStorageBuffer(largest, limitReport(SPEC_MINIMUM_DEVICE)),
    false,
    "128 MB of binding ceiling against a ~525 MB initializer means a silent WASM fallback",
  );
  assert.equal(
    fitsStorageBuffer(largest, { maxStorageBufferMB: 2047 }),
    true,
    "the adapter's own limits are what make the default row actually runnable",
  );
});

test("fitsStorageBuffer says nothing rather than rejecting on missing data", () => {
  assert.equal(fitsStorageBuffer(undefined, limitReport(SPEC_MINIMUM_DEVICE)), null);
  assert.equal(fitsStorageBuffer(1e6, null), null);
  assert.equal(fitsStorageBuffer(1e6, {}), null);
});
