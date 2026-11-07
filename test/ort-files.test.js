import { test } from "node:test";
import assert from "node:assert/strict";
import { ORT_WEBGPU_FILES, isWasm, ortCdnBase, resolveOrtBase } from "../lib/ort-files.js";

const LOCAL = "https://aura.example/ort/";
const VERSION = "1.31.0-dev.20260914-8d85527a0";
const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const HTML = new TextEncoder().encode("<!doctype html><title>Aura</title>");

// A fetch that serves `body(url)` as a one-chunk stream and records what it saw.
function fakeFetch(body) {
  const seen = [];
  const impl = async (url) => {
    seen.push(url);
    const bytes = body(url);
    if (bytes === null) throw new TypeError("network error");
    let cancelled = false;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (cancelled ? { done: true } : { done: false, value: bytes }),
          cancel: async () => { cancelled = true; },
        }),
      },
    };
  };
  return { impl, seen };
}

test("isWasm reads the magic word", () => {
  assert.ok(isWasm(WASM));
  assert.ok(!isWasm(HTML));
  assert.ok(!isWasm(new Uint8Array([0, 0x61])));
  assert.ok(!isWasm(null));
});

test("same-origin files that are real wasm stay same-origin (offline keeps working)", async () => {
  const { impl, seen } = fakeFetch(() => WASM);
  assert.deepEqual(await resolveOrtBase({ local: LOCAL, version: VERSION, fetchImpl: impl }), { base: LOCAL, source: "local" });
  assert.deepEqual(seen, ORT_WEBGPU_FILES.map((f) => LOCAL + f));
});

test("an SPA fallback serving index.html for a dropped file switches to jsDelivr", async () => {
  // Pages: the plain build is there, the >25 MiB jsep build is not.
  const { impl } = fakeFetch((url) => (url.startsWith(LOCAL) && url.includes("jsep") ? HTML : WASM));
  assert.deepEqual(await resolveOrtBase({ local: LOCAL, version: VERSION, fetchImpl: impl }), {
    base: ortCdnBase(VERSION),
    source: "cdn",
  });
  assert.equal(ortCdnBase(VERSION), `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VERSION}/dist/`);
});

test("neither source: fails before any model download, naming what is missing", async () => {
  const { impl } = fakeFetch((url) => (url.startsWith(LOCAL) ? HTML : null));
  await assert.rejects(resolveOrtBase({ local: LOCAL, version: VERSION, fetchImpl: impl }), /doesn't serve ONNX Runtime's WebGPU files.*jsDelivr copy.*nothing was downloaded/);
  // No version to look up on the CDN: still fails up front.
  await assert.rejects(resolveOrtBase({ local: LOCAL, fetchImpl: impl }), /nothing was downloaded/);
});
