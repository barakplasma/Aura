import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanBrowser,
  loadBrowserModel,
  isBrowserModelLoaded,
  browserModelDevice,
  BROWSER_MODELS,
  DEFAULT_BROWSER_MODEL,
  loadDetector,
  detectObjects,
  isDetectorLoaded,
  unloadDetector,
  DETECTOR_MODELS,
  DEFAULT_DETECTOR_MODEL,
  _setWorkerFactory,
  _resetBrowserEngine,
} from "../lib/browser-engine.js";

// A minimal stand-in for a real Worker — `new Worker()` doesn't run under
// `node --test`, so every test injects one of these instead via
// _setWorkerFactory(). It records every posted message and lets the test
// script deliver replies (or a crash) on its own schedule, out of order if
// it wants to.
class FakeWorker {
  constructor() {
    this.posted = [];
    this.listeners = { message: [], error: [], messageerror: [] };
    this.terminated = false;
  }
  postMessage(msg, transfer) {
    this.posted.push(msg);
    if (transfer) this.transfers = [...(this.transfers || []), transfer];
  }
  addEventListener(type, fn) {
    this.listeners[type]?.push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  terminate() {
    this.terminated = true;
  }
  // Deliver a { id, type, ... } reply as if it came from the worker thread.
  reply(data) {
    for (const fn of this.listeners.message) fn({ data });
  }
  crash(message) {
    for (const fn of this.listeners.error) fn({ message });
  }
}

// Fresh fake worker + facade state for every test.
function freshWorker() {
  let fw;
  _setWorkerFactory(() => {
    fw = new FakeWorker();
    return fw;
  });
  _resetBrowserEngine();
  return () => fw; // the factory only runs lazily on first send(); read via getter
}

// loadBrowserModel()/scanBrowser() are async and post their worker message
// after at least one microtask tick (even the "already loaded" fast path
// resolves through a Promise) — spin microtasks until the expected message
// has actually landed in `posted`, rather than asserting on it immediately.
async function waitForPosted(fw, n) {
  for (let i = 0; i < 50 && fw.posted.length < n; i++) {
    await Promise.resolve();
  }
}

// Shared setup for tests that just need a model already loaded before
// exercising scanBrowser()/abort/crash behavior — distinct from the "error"
// reply case below, which tests the load path failing. Returns `getWorker`
// too, since a test recovering from a crash needs it again to grab the next
// fake worker the factory produces.
// Loads DEFAULT_BROWSER_MODEL, because that is what a scanBrowser() call with
// no explicit `model` asks for — loading anything else here would make every
// scan below post its own 'load' first and throw the message counts off.
async function loadedFakeWorker(device = "wasm") {
  const getWorker = freshWorker();
  const loadP = loadBrowserModel(DEFAULT_BROWSER_MODEL);
  const fw = getWorker();
  fw.reply({ id: fw.posted[0].id, type: "ready", device });
  await loadP;
  return { fw, getWorker };
}

test.beforeEach(() => {
  _resetBrowserEngine();
});

test("loadBrowserModel resolves on the worker's 'ready' reply, matched by id", async () => {
  const getWorker = freshWorker();
  const p = loadBrowserModel("smolvlm2-256m");
  const fw = getWorker();
  assert.equal(fw.posted.length, 1);
  const req = fw.posted[0];
  assert.equal(req.type, "load");
  assert.equal(req.model, BROWSER_MODELS["smolvlm2-256m"].modelId);
  fw.reply({ id: req.id, type: "ready", device: "webgpu" });
  const result = await p;
  assert.equal(result.device, "webgpu");
  assert.equal(isBrowserModelLoaded("smolvlm2-256m"), true);
  assert.equal(browserModelDevice(), "webgpu");
});

test("loadBrowserModel de-dupes overlapping calls for the same model into one worker request", async () => {
  const getWorker = freshWorker();
  const p1 = loadBrowserModel("smolvlm2-256m");
  const p2 = loadBrowserModel("smolvlm2-256m");
  const fw = getWorker();
  assert.equal(fw.posted.length, 1, "only one 'load' message for two overlapping calls");
  fw.reply({ id: fw.posted[0].id, type: "ready", device: "wasm" });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.device, "wasm");
  assert.equal(r2.device, "wasm");
});

test("scanBrowser correlates concurrent requests by id, not by reply order", async () => {
  // Load once, up front, so the two scans below post exactly one 'scan'
  // message each (no interleaved 'load').
  const { fw } = await loadedFakeWorker("webgpu");

  const scanA = scanBrowser({ mission: "a person at the door", image: "x".repeat(64) });
  const scanB = scanBrowser({ mission: "a package on the porch", image: "y".repeat(64) });
  await waitForPosted(fw, 3); // 1 load + 2 scan

  const [reqA, reqB] = fw.posted.slice(-2);
  assert.equal(reqA.type, "scan");
  assert.notEqual(reqA.id, reqB.id);

  // Reply out of order — B's own id gets B's own text, A's id gets A's,
  // regardless of which one is answered first.
  fw.reply({
    id: reqB.id,
    type: "result",
    text: "YES 70 a package is visible",
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  });
  fw.reply({
    id: reqA.id,
    type: "result",
    text: "NO 5 nothing at the door",
    usage: { prompt_tokens: 20, completion_tokens: 6 },
  });

  const [resultA, resultB] = await Promise.all([scanA, scanB]);
  assert.equal(resultA.triggered, false);
  assert.equal(resultA.reason, "nothing at the door");
  assert.equal(resultA.mode, "browser");
  assert.equal(resultB.triggered, true);
  assert.equal(resultB.confidence, 70);
  assert.equal(resultB.reason, "a package is visible");
});

test("aborting a scan rejects the in-flight promise and tells the worker to stop", async () => {
  const { fw } = await loadedFakeWorker();

  const controller = new AbortController();
  const scanPromise = scanBrowser({
    mission: "watch the door",
    image: "x".repeat(64),
    signal: controller.signal,
  });
  await waitForPosted(fw, 2); // 1 load + 1 scan
  const scanReq = fw.posted.at(-1);
  controller.abort();

  await assert.rejects(scanPromise, (err) => {
    assert.equal(err.name, "AbortError");
    return true;
  });
  // The worker was actually told to stop generating, not just abandoned.
  const abortMsg = fw.posted.find((m) => m.type === "abort" && m.id === scanReq.id);
  assert.ok(abortMsg, "an 'abort' message with the scan's id was posted");

  // A late reply for the aborted request must not resurrect/crash anything.
  assert.doesNotThrow(() =>
    fw.reply({ id: scanReq.id, type: "result", text: "NO 0 too late" }),
  );
});

test("a worker crash rejects every in-flight promise with a useful message", async () => {
  const { fw, getWorker } = await loadedFakeWorker();

  const scanA = scanBrowser({ mission: "a", image: "x".repeat(64) });
  const scanB = scanBrowser({ mission: "b", image: "y".repeat(64) });
  await waitForPosted(fw, 3); // 1 load + 2 scan
  fw.crash("out of memory");

  await assert.rejects(scanA, /crash/i);
  await assert.rejects(scanB, /crash/i);
  // The dead worker's cached state must not poison the next call — a fresh
  // load should work again with a brand-new fake worker.
  const p = loadBrowserModel("smolvlm2-256m");
  const fw2 = getWorker();
  assert.notEqual(fw2, fw);
  fw2.reply({ id: fw2.posted[0].id, type: "ready", device: "wasm" });
  await p;
  assert.equal(isBrowserModelLoaded("smolvlm2-256m"), true);
});

test("a worker 'error' message (not just an error event) also fails the pending request", async () => {
  const getWorker = freshWorker();
  const loadP = loadBrowserModel("smolvlm2-256m");
  const fw = getWorker();
  fw.reply({ id: fw.posted[0].id, type: "error", message: "model repo not found" });
  await assert.rejects(loadP, /model repo not found/);
});

// --- Object gate ----------------------------------------------------------

test("loadDetector posts a 'detect' task load and remembers the device", async () => {
  const getWorker = freshWorker();
  const p = loadDetector("yolo26n-int8");
  const fw = getWorker();
  await waitForPosted(fw, 1);
  const req = fw.posted[0];
  assert.equal(req.type, "load");
  assert.equal(req.task, "detect", "the VLM's slot must not be touched");
  assert.equal(req.model, DETECTOR_MODELS["yolo26n-int8"].modelId);
  assert.equal(req.dtype, "int8");
  fw.reply({ id: req.id, type: "ready", device: "wasm" });
  assert.deepEqual(await p, { device: "wasm" });
  assert.equal(isDetectorLoaded("yolo26n-int8"), true);
  assert.equal(isDetectorLoaded("yolo26n-fp16"), false);
});

test("loadDetector de-duplicates concurrent loads of the same row", async () => {
  const getWorker = freshWorker();
  const a = loadDetector(DEFAULT_DETECTOR_MODEL);
  const b = loadDetector(DEFAULT_DETECTOR_MODEL);
  const fw = getWorker();
  await waitForPosted(fw, 1);
  assert.equal(fw.posted.length, 1, "one load message for two callers");
  fw.reply({ id: fw.posted[0].id, type: "ready", device: "webgpu" });
  assert.deepEqual(await Promise.all([a, b]), [
    { device: "webgpu" },
    { device: "webgpu" },
  ]);
});

test("loadDetector rejects an unknown row without posting anything", async () => {
  const getWorker = freshWorker();
  await assert.rejects(loadDetector("yolo99-xl"), /Unknown detector model/);
  assert.equal(getWorker(), undefined, "no worker is even spawned");
});

test("detectObjects transfers the bitmap and returns the raw tensors", async () => {
  const getWorker = freshWorker();
  const bitmap = { close() {} }; // stand-in for an ImageBitmap
  const p = detectObjects(bitmap, { model: "yolo26n-int8" });
  const fw = getWorker();
  await waitForPosted(fw, 1);
  // The detector has to load first — detectObjects() drives that itself.
  fw.reply({ id: fw.posted[0].id, type: "ready", device: "wasm" });
  await waitForPosted(fw, 2);
  const req = fw.posted[1];
  assert.equal(req.type, "detect");
  assert.equal(req.size, DETECTOR_MODELS["yolo26n-int8"].inputSize);
  assert.equal(req.bitmap, bitmap);
  assert.deepEqual(fw.transfers.at(-1), [bitmap], "bitmap is transferred, not copied");

  const logits = new Float32Array([1, 2, 3]);
  const boxes = new Float32Array([0.5, 0.5, 0.2, 0.2]);
  fw.reply({
    id: req.id,
    type: "detections",
    logits,
    logitsDims: [300, 80],
    boxes,
    boxesDims: [300, 4],
    latencyMs: 31,
  });
  const out = await p;
  assert.equal(out.logits, logits);
  assert.equal(out.boxes, boxes);
  assert.deepEqual(out.dims, [300, 80]);
  assert.equal(out.latencyMs, 31);
});

test("a worker crash rejects an in-flight detect and drops the detector", async () => {
  const getWorker = freshWorker();
  const loadP = loadDetector("yolo26n-int8");
  const fw = getWorker();
  await waitForPosted(fw, 1);
  fw.reply({ id: fw.posted[0].id, type: "ready", device: "wasm" });
  await loadP;
  const p = detectObjects({ close() {} }, { model: "yolo26n-int8" });
  await waitForPosted(fw, 2);
  fw.crash("out of memory");
  await assert.rejects(p, /worker crashed/);
  assert.equal(isDetectorLoaded("yolo26n-int8"), false, "state is dropped with the worker");
});

test("unloadDetector frees only the detector's slot", async () => {
  const getWorker = freshWorker();
  const loadP = loadDetector("yolo26n-int8");
  const fw = getWorker();
  await waitForPosted(fw, 1);
  fw.reply({ id: fw.posted[0].id, type: "ready", device: "wasm" });
  await loadP;
  const p = unloadDetector();
  await waitForPosted(fw, 2);
  const req = fw.posted[1];
  assert.equal(req.type, "unload");
  assert.equal(req.task, "detect");
  fw.reply({ id: req.id, type: "ready", device: null });
  await p;
  assert.equal(isDetectorLoaded("yolo26n-int8"), false);
});
