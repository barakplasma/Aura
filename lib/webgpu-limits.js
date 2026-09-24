// WebGPU device-limit helpers for the BROWSER engine.
//
// ONNX Runtime Web creates its WebGPU device with the *spec minimum* limits,
// and Transformers.js does not raise them. `maxStorageBufferBindingSize` is
// the one that matters: it caps the size of a storage buffer that may be
// *bound* in a bind group — which is exactly how an ONNX initializer reaches a
// compute shader. A merged-decoder weight file bigger than the cap therefore
// cannot be bound, and the session quietly falls back to the WASM EP instead
// of reporting a WebGPU failure.
//
// Measured on the reference phone (Pixel 7a, Chrome 153):
//   adapter.limits.maxStorageBufferBindingSize = 2147483644 (2 GiB)
//   adapter.requestDevice().limits            =  134217728 (128 MiB)
// Binding at the device's own limit succeeds; one byte over it fails. Qwen3.5
// 0.8B's merged decoder is ~525 MB, so on the default device every scan that
// model runs is WASM, whatever Settings advertises.
//
// Requesting the adapter's own limits is the fix, and it must happen BEFORE
// the first session is created — `env.backends.onnx.webgpu.device` is a plain
// assignment here and is never read, because reading it is itself
// device-creating: that would lock in a device before we could choose one.
//
// Pure and dependency-free (same pattern as lib/model-size.js and
// lib/download-progress.js) so the policy is unit-testable under `node --test`
// without a Worker, a GPU, or the ~900 MB download.

const F16_FEATURE = "shader-f16";

// The only limits worth asking for. Both are core limits with no gating
// feature, and `maxStorageBufferBindingSize` is the one that decides whether a
// large initializer can be bound at all.
const REQUESTED_LIMITS = ["maxStorageBufferBindingSize", "maxBufferSize"];

/**
 * The `requestDevice()` argument that raises the buffer limits to what the
 * adapter itself allows.
 *
 * Each limit is read *by name* rather than by enumerating `adapter.limits`,
 * and that is load-bearing: `GPUSupportedLimits` exposes its values as
 * prototype accessors, so `Object.keys(adapter.limits)` returns an empty array
 * and a copy loop silently requests nothing. The device then comes back on the
 * 128 MiB default while every value still reads correctly through a direct
 * property access — the mismatch that made an earlier revision of this helper
 * report success while the session ran on spec-minimum limits.
 *
 * `shader-f16` is requested when available because every VLM row in
 * lib/browser-models.js carries at least one fp16 component; no other feature
 * is demanded, since some (e.g. `native`) can require permissions a monitor
 * should not trigger.
 *
 * Returns null when there is nothing to request, meaning "let the caller fall
 * back to whatever device it would have used anyway".
 */
export function deviceRequest(adapter) {
  const limits = adapter?.limits;
  if (!limits) return null;
  const requiredLimits = {};
  for (const key of REQUESTED_LIMITS) {
    const value = limits[key];
    if (Number.isFinite(value) && value > 0) requiredLimits[key] = value;
  }
  const features = adapter.features;
  const requiredFeatures =
    typeof features?.has === "function" && features.has(F16_FEATURE) ? [F16_FEATURE] : [];
  if (Object.keys(requiredLimits).length === 0 && requiredFeatures.length === 0) return null;
  return { requiredLimits, requiredFeatures };
}

/**
 * The limits a created device ended up with, in the units the UI and the model
 * table think in. Null when the platform gave us no device to describe.
 *
 * `maxStorageBufferMB` is what a single initializer must fit inside, so
 * publishing it turns "is this model actually running on WebGPU?" from a guess
 * into a number on screen.
 *
 * `adapterMaxStorageBufferMB` is the ceiling the adapter was asked for. It is
 * reported alongside the granted value because a driver may clamp the request,
 * and because a Worker can be handed a different (lower-limit) adapter than
 * the page that spawned it — granted-without-requested cannot distinguish
 * "the driver clamped us" from "we never asked high enough".
 */
export function limitReport(device, adapter) {
  const limits = device?.limits;
  if (!limits) return null;
  const mb = (n) => (Number.isFinite(n) ? Math.round(n / 1048576) : null);
  return {
    maxStorageBufferMB: mb(limits.maxStorageBufferBindingSize),
    maxBufferMB: mb(limits.maxBufferSize),
    adapterMaxStorageBufferMB: mb(adapter?.limits?.maxStorageBufferBindingSize),
    shaderF16:
      typeof device.features?.has === "function" ? device.features.has(F16_FEATURE) : null,
  };
}

/**
 * Whether a model's biggest weight file can be bound on a device.
 *
 * `largestWeightBytes` is the stored approximation lib/browser-models.js
 * already uses for its picker; an unknown size or an unknown limit is treated
 * as "can't say", which callers must read as permissive rather than as a
 * rejection — the download is the expensive step, not this check.
 */
export function fitsStorageBuffer(largestWeightBytes, report) {
  if (!Number.isFinite(largestWeightBytes) || !report) return null;
  if (!Number.isFinite(report.maxStorageBufferMB)) return null;
  return largestWeightBytes <= report.maxStorageBufferMB * 1048576;
}
