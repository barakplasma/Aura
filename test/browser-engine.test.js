import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanBrowser,
  loadBrowserModel,
  isBrowserModelLoaded,
  browserModelDevice,
  browserDeviceLimits,
  unloadBrowserModel,
  BROWSER_MODELS,
  DEFAULT_BROWSER_MODEL,
  FALLBACK_BROWSER_MODEL,
  resolveBrowserRuntime,
  selectBrowserDevice,
  loadDetector,
  detectObjects,
  isDetectorLoaded,
  unloadDetector,
  DETECTOR_MODELS,
  DEFAULT_DETECTOR_MODEL,
  _setWorkerFactory,
  _setChromeAICall,
  _setChromeAIProbe,
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

// Start one scan against an already-loaded fake worker and wait for its
// 'scan' message to land. Returns the scan promise and that message, so the
// single-frame tests below can assert on and reply to it without repeating
// the same start-and-wait dance.
async function startedScan(fw, params) {
  const p = scanBrowser({ model: FALLBACK_BROWSER_MODEL, ...params });
  await waitForPosted(fw, 2); // setup load + this scan
  return { p, req: fw.posted.at(-1) };
}

// Shared setup for tests that just need a model already loaded before
// exercising scanBrowser()/abort/crash behavior — distinct from the "error"
// reply case below, which tests the load path failing. Returns `getWorker`
// too, since a test recovering from a crash needs it again to grab the next
// fake worker the factory produces.
// Loads the WASM-safe row so these facade tests do not pretend Node's lack of
// WebGPU can load the default fp16-only VLM.
async function loadedFakeWorker(device = "wasm") {
  const getWorker = freshWorker();
  const loadP = loadBrowserModel(FALLBACK_BROWSER_MODEL);
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

// The worker reports the WebGPU limits its session actually got, because a
// spec-minimum 128 MB binding ceiling means the model silently ran on WASM
// while the UI said WebGPU. The number has to survive the facade to the
// Settings STATUS line.
test("loadBrowserModel publishes the worker's device limits", async () => {
  const getWorker = freshWorker();
  const p = loadBrowserModel(FALLBACK_BROWSER_MODEL);
  const fw = getWorker();
  fw.reply({
    id: fw.posted[0].id,
    type: "ready",
    device: "webgpu",
    limits: { maxStorageBufferMB: 2047, maxBufferMB: 4095, shaderF16: true },
  });
  await p;
  assert.equal(browserDeviceLimits().maxStorageBufferMB, 2047);

  const unloadP = unloadBrowserModel();
  await waitForPosted(fw, 2);
  fw.reply({ id: fw.posted.at(-1).id, type: "ready", device: null });
  await unloadP;
  assert.equal(browserDeviceLimits(), null, "unloading must not leave stale limits behind");
});

test("a worker that reports no limits leaves nothing stale to display", async () => {
  const { fw } = await loadedFakeWorker("webgpu");
  assert.equal(browserDeviceLimits(), null);
});

test("selectBrowserDevice uses WASM when WebGPU lacks shader-f16", async () => {
  const noFp16 = {
    gpu: { requestAdapter: async () => ({ features: new Set() }) },
  };
  assert.equal(
    await selectBrowserDevice(BROWSER_MODELS["smolvlm2-256m"], noFp16),
    "wasm",
  );
  await assert.rejects(
    selectBrowserDevice(BROWSER_MODELS["smolvlm2-500m"], noFp16),
    /requires WebGPU with fp16 support/,
  );
});

test("selectBrowserDevice rejects a WebGPU-only model when WebGPU is absent", async () => {
  assert.throws(
    () => selectBrowserDevice(BROWSER_MODELS["qwen3.5-0.8b"], {}),
    /does not provide WebGPU/,
  );
  assert.equal(
    selectBrowserDevice(BROWSER_MODELS["smolvlm2-256m"], {}),
    "wasm",
  );
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

  const scanA = scanBrowser({ model: FALLBACK_BROWSER_MODEL, mission: "a person at the door", image: "x".repeat(64) });
  const scanB = scanBrowser({ model: FALLBACK_BROWSER_MODEL, mission: "a package on the porch", image: "y".repeat(64) });
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

test("scanBrowser forwards the single frame as a one-element image list", async () => {
  const { fw } = await loadedFakeWorker("webgpu");
  const { p, req } = await startedScan(fw, { mission: "a person at the door", image: "x".repeat(64) });
  assert.equal(req.type, "scan");
  assert.deepEqual(req.imageDataUrls, [`data:image/jpeg;base64,${"x".repeat(64)}`]);
  fw.reply({ id: req.id, type: "result", text: "NO 0 nothing", usage: {} });
  await p;
});

test("scanBrowser forwards every frame when temporal analysis passes a sequence", async () => {
  // The SmolVLM2-Video follow-up: the pipeline must not assume one frame
  // forever. `images` (a short frame sequence) supersedes `image`.
  const { fw } = await loadedFakeWorker("webgpu");
  const { p, req } = await startedScan(fw, {
    mission: "did someone approach and then leave",
    image: "a".repeat(64),
    images: ["b".repeat(64), "c".repeat(64)],
  });
  assert.deepEqual(req.imageDataUrls, [
    `data:image/jpeg;base64,${"b".repeat(64)}`,
    `data:image/jpeg;base64,${"c".repeat(64)}`,
  ]);
  fw.reply({ id: req.id, type: "result", text: "NO 0 nothing", usage: {} });
  await p;
});

test("aborting a scan rejects the in-flight promise and tells the worker to stop", async () => {
  const { fw } = await loadedFakeWorker();

  const controller = new AbortController();
  const scanPromise = scanBrowser({
    model: FALLBACK_BROWSER_MODEL,
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

  const scanA = scanBrowser({ model: FALLBACK_BROWSER_MODEL, mission: "a", image: "x".repeat(64) });
  const scanB = scanBrowser({ model: FALLBACK_BROWSER_MODEL, mission: "b", image: "y".repeat(64) });
  await waitForPosted(fw, 3); // 1 load + 2 scan
  fw.crash("out of memory");

  await assert.rejects(scanA, /crash/i);
  await assert.rejects(scanB, /crash/i);
  assert.equal(fw.terminated, true, "a failed worker is terminated before recovery");
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

test("the logit margin overrides a confidence the model wrote", async () => {
  // A small model's "Confidence: 95" is generated text; P(YES) vs P(NO) at the
  // verdict step is the evidence. At 30% it must not clear a 60% threshold.
  const { fw } = await loadedFakeWorker("webgpu");
  const { p, req } = await startedScan(fw, { mission: "a person", image: "x".repeat(64), threshold: 60 });
  assert.equal(req.wantLogits, true);
  assert.equal(req.repetitionPenalty, undefined, "the verdict step must not be penalised");
  fw.reply({
    id: req.id,
    type: "result",
    text: "YES, Confidence: 95, Explanation: a person",
    logits: { verdictAtFirstStep: true, verdictProb: 0.3, firstTokenProb: 0.3 },
    timing: { preprocessMs: 5, prefillMs: 900, decodeMs: 300 },
    usage: {},
  });
  const r = await p;
  assert.equal(r.confidence, 30);
  assert.equal(r.triggered, false);
  assert.equal(r.timing.prefillMs, 900, "the prefill/decode split reaches the caller");
});

test("a margin read at a non-verdict step leaves the parsed confidence alone", async () => {
  const { fw } = await loadedFakeWorker("webgpu");
  const { p, req } = await startedScan(fw, { mission: "a person", image: "x".repeat(64) });
  fw.reply({
    id: req.id,
    type: "result",
    text: "NO 5 empty room",
    logits: { verdictAtFirstStep: false, verdictProb: 0.9 },
    usage: {},
  });
  assert.equal((await p).confidence, 5);
});

test("only the prose legs ask for a repetition penalty", async () => {
  const { fw } = await loadedFakeWorker("webgpu");
  const p = scanBrowser({
    model: FALLBACK_BROWSER_MODEL,
    mission: "a person",
    action: "say hello",
    webhookAction: "summarise",
    image: "x".repeat(64),
    threshold: 50,
  });
  await waitForPosted(fw, 2);
  const det = fw.posted.at(-1);
  fw.reply({ id: det.id, type: "result", text: "YES 90 a person", usage: {} });
  await waitForPosted(fw, 3);
  const act = fw.posted.at(-1);
  assert.equal(act.purpose, "announce");
  assert.ok(act.repetitionPenalty > 1);
  assert.notEqual(act.wantLogits, true);
  fw.reply({ id: act.id, type: "result", text: "Hello there.", usage: {} });
  await waitForPosted(fw, 4);
  const wh = fw.posted.at(-1);
  assert.equal(wh.purpose, "webhook");
  assert.ok(wh.repetitionPenalty > 1);
  fw.reply({ id: wh.id, type: "result", text: "A person arrived.", usage: {} });
  const r = await p;
  assert.equal(r.triggered, true);
});

test("a lost GPU device fails in-flight work and replaces the worker", async () => {
  const { fw, getWorker } = await loadedFakeWorker("webgpu");
  const scan = scanBrowser({ model: FALLBACK_BROWSER_MODEL, mission: "a", image: "x".repeat(64) });
  await waitForPosted(fw, 2);
  fw.reply({ type: "fatal", message: "WebGPU device lost: unknown" });
  await assert.rejects(scan, /lost its GPU/);
  assert.equal(fw.terminated, true);
  assert.equal(isBrowserModelLoaded(FALLBACK_BROWSER_MODEL), false);
  const p = loadBrowserModel(FALLBACK_BROWSER_MODEL);
  const fw2 = getWorker();
  assert.notEqual(fw2, fw, "the next call spawns a fresh worker");
  fw2.reply({ id: fw2.posted[0].id, type: "ready", device: "webgpu" });
  await p;
});

// --- Chrome built-in AI runtime -------------------------------------------

test("resolveBrowserRuntime: Auto picks Chrome built-in AI only when fully capable", async () => {
  // The whole policy: 'available' AND image-capable, nothing less. A
  // 'downloadable' Gemini Nano must not be silently triggered into a ~2 GB
  // download by an automatic choice — that stays an explicit user decision.
  _setChromeAIProbe(async () => ({ present: true, availability: "available", imageCapable: true }));
  assert.equal(await resolveBrowserRuntime("auto"), "chrome-ai");

  _setChromeAIProbe(async () => ({ present: true, availability: "available", imageCapable: false }));
  assert.equal(await resolveBrowserRuntime("auto"), "transformers", "no image input, no vision detection");

  _setChromeAIProbe(async () => ({ present: true, availability: "downloadable", imageCapable: false }));
  assert.equal(await resolveBrowserRuntime("auto"), "transformers");

  _setChromeAIProbe(async () => ({ present: false, availability: "absent", imageCapable: false }));
  assert.equal(await resolveBrowserRuntime("auto"), "transformers");
});

test("resolveBrowserRuntime: explicit choices always win", async () => {
  _setChromeAIProbe(async () => ({ present: false, availability: "absent", imageCapable: false }));
  assert.equal(await resolveBrowserRuntime("transformers"), "transformers");
  // An explicit chrome-ai pick is honored — the scan surfaces an actionable
  // error when the browser can't honor it (lib/chrome-ai.js).
  assert.equal(await resolveBrowserRuntime("chrome-ai"), "chrome-ai");
});

test("scanBrowser routes to the Chrome built-in AI transport without touching the worker", async () => {
  const getWorker = freshWorker();
  const chromeCalls = [];
  _setChromeAICall(async (params) => {
    chromeCalls.push(params);
    return {
      text: '{"triggered":true,"confidence":91,"reason":"a person at the door"}',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reported: false },
    };
  });

  const result = await scanBrowser({
    mission: "a person at the door",
    image: "x".repeat(64),
    runtime: "chrome-ai",
  });

  assert.equal(result.mode, "browser");
  assert.equal(result.runtime, "chrome-ai");
  assert.equal(result.triggered, true);
  assert.equal(result.confidence, 91);
  assert.equal(result.reason, "a person at the door");
  // No action prompt configured — exactly one detection call went out.
  assert.equal(chromeCalls.length, 1);
  assert.ok(chromeCalls[0].schema, "the detection call carries a JSON schema");
  assert.equal(chromeCalls[0].signal, undefined);
  // Nothing was posted to a worker — no model download, no load messages.
  assert.equal(getWorker(), undefined, "the worker was never spawned");
});

test("scanBrowser on the Transformers runtime still answers through the worker and reports the runtime", async () => {
  const { fw } = await loadedFakeWorker("webgpu");
  const { p, req } = await startedScan(fw, { mission: "a person at the door", image: "x".repeat(64) });
  fw.reply({ id: req.id, type: "result", text: "NO 5 nothing", usage: {} });
  const result = await p;
  assert.equal(result.runtime, "transformers");
  // Eval-screen provenance: which device answered, and what the one-time
  // model load cost (null when the model was already resident).
  assert.equal(result.device, "webgpu");
  assert.equal(result.modelLoadMs, null);
});

test("scanBrowser reports the fresh model load time on the first scan only", async () => {
  const getWorker = freshWorker();
  const first = scanBrowser({ model: FALLBACK_BROWSER_MODEL, mission: "m", image: "x".repeat(64) });
  // The worker spawns after runtime resolution (an async probe deep) — spin
  // microtasks until the factory has actually run.
  for (let i = 0; i < 50 && !getWorker(); i++) await Promise.resolve();
  const fw = getWorker();
  await waitForPosted(fw, 1); // the 'load' posts first…
  fw.reply({ id: fw.posted[0].id, type: "ready", device: "wasm" });
  // …and only once the load resolves does the scan itself get posted.
  await waitForPosted(fw, 2);
  const scanReq = fw.posted.at(-1);
  fw.reply({ id: scanReq.id, type: "result", text: "NO 0 nothing", usage: {} });
  const r1 = await first;
  assert.ok(Number.isFinite(r1.modelLoadMs) && r1.modelLoadMs >= 0, "first scan pays the load");
  assert.equal(r1.device, "wasm");

  const second = scanBrowser({ model: FALLBACK_BROWSER_MODEL, mission: "m", image: "x".repeat(64) });
  // Warm model: no 'load' this time — the scan message is the next post.
  await waitForPosted(fw, 3);
  const req2 = fw.posted.at(-1);
  fw.reply({ id: req2.id, type: "result", text: "NO 0 nothing", usage: {} });
  const r2 = await second;
  assert.equal(r2.modelLoadMs, null, "warm model — no load time reported");
});

test("a stored runtime of 'auto' resolves before transport selection", async () => {
  // useMonitor passes the persisted aura.browserRuntime straight through, and
  // its default is the literal string "auto" — which is truthy, so it must be
  // RESOLVED, not treated as an explicit transport choice. (Pre-fix, the scan
  // misroutes into the worker path and never settles, hence the race.)
  // NOTE: freshWorker() resets the runtime seams — set them after it.
  const getWorker = freshWorker();
  _setChromeAIProbe(async () => ({ present: true, availability: "available", imageCapable: true }));
  let chromeCalls = 0;
  _setChromeAICall(async () => {
    chromeCalls += 1;
    return { text: "NO 0 nothing", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reported: false } };
  });

  const result = await Promise.race([
    scanBrowser({ mission: "m", image: "x".repeat(64), runtime: "auto" }),
    new Promise((_, rej) => setTimeout(() => rej(new Error("scan never settled — misrouted")), 500)),
  ]);

  assert.equal(result.runtime, "chrome-ai", "'auto' must resolve, not pass through");
  assert.equal(chromeCalls, 1);
  assert.equal(getWorker(), undefined, "no worker spawned on the auto-resolved chrome path");
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
