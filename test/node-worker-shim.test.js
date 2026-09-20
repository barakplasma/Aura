// Unit tests for the e2e Node worker shim (e2e/node-worker.mjs).
//
// The e2e harness runs the REAL src/workers/ml.worker.js in-process under
// Node by handing browser-engine's _setWorkerFactory() a shim that speaks
// the browser Worker interface (postMessage / addEventListener / terminate).
// The only adaptation it may make in transit is rewriting the load message's
// device 'wasm' → 'cpu' — Node has no WebGPU, and onnxruntime-node's native
// CPU execution provider is both correct and far faster than WASM there.
//
// These tests pin that bridge with a tiny echo worker that registers itself
// exactly the way the real worker does (self.addEventListener /
// self.postMessage), so the shim's globals install and event shapes are what
// is actually under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createNodeWorkerShim } from "../e2e/node-worker.mjs";

const ECHO_WORKER = new URL("fixtures/node-shim-echo-worker.mjs", import.meta.url);

// Poll-collector: appends every {data} event the shim delivers and lets
// tests await a specific reply without hanging forever.
function collector() {
  const events = [];
  const wait = (pred, ms = 2000) =>
    new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const hit = events.find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - start > ms)
          return reject(new Error("timed out waiting for shim reply"));
        setTimeout(tick, 10);
      };
      tick();
    });
  return { events, wait };
}

test("bridges postMessage/addEventListener both ways to an in-process module", async () => {
  const shim = await createNodeWorkerShim(ECHO_WORKER);
  const got = collector();
  shim.addEventListener("message", (event) => got.events.push(event.data));
  shim.postMessage({ id: 1, type: "ping", device: "wasm" });
  const reply = await got.wait((d) => d.id === 1);
  assert.equal(reply.type, "echo");
  assert.equal(reply.sawType, "ping");
  assert.equal(reply.sawDevice, "wasm", "non-load messages pass through untouched");
  shim.terminate();
});

test("rewrites the load message's device from wasm to cpu", async () => {
  const shim = await createNodeWorkerShim(ECHO_WORKER);
  const got = collector();
  shim.addEventListener("message", (event) => got.events.push(event.data));
  shim.postMessage({ id: 2, type: "load", device: "wasm" });
  const reply = await got.wait((d) => d.id === 2);
  assert.equal(reply.sawDevice, "cpu", "load must reach the worker as the native CPU device");
  shim.terminate();
});

test("terminate stops delivery; a fresh shim re-imports the same module cleanly", async () => {
  const shim = await createNodeWorkerShim(ECHO_WORKER);
  const got = collector();
  shim.addEventListener("message", (event) => got.events.push(event.data));
  shim.postMessage({ id: 3, type: "ping" });
  await got.wait((d) => d.id === 3);
  shim.terminate();

  assert.doesNotThrow(() => shim.postMessage({ id: 4, type: "ping" }));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(got.events.filter((d) => d.id === 4).length, 0, "no delivery after terminate");

  // Same URL, new instance — the ESM loader must give it a fresh module run
  // (cache-busting query) or the second shim would share a corpse.
  const shim2 = await createNodeWorkerShim(ECHO_WORKER);
  shim2.addEventListener("message", (event) => got.events.push(event.data));
  shim2.postMessage({ id: 5, type: "ping" });
  const reply = await got.wait((d) => d.id === 5);
  assert.equal(reply.sawType, "ping");
  shim2.terminate();
});
