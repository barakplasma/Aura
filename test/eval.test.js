import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandMatrix,
  comboKey,
  runEvalMatrix,
  summarizeResults,
} from "../lib/eval.js";
import { createEvalStore, createMemoryAdapter } from "../lib/eval-store.js";

const VARIANTS = [
  { id: "pv_a", name: "A", mission: "watch the door", instruction: "" },
  { id: "pv_b", name: "B", mission: "alert on any person", instruction: "be strict" },
];
const IMAGES = {
  img_1: { id: "img_1", dataUrl: "data:image/jpeg;base64,AAA" },
  img_2: { id: "img_2", dataUrl: "data:image/jpeg;base64,BBB" },
};
const VARIANTS_BY_ID = Object.fromEntries(VARIANTS.map((v) => [v.id, v]));

function okScan({ triggered = false, confidence = 10, tokens = 100 } = {}) {
  return {
    triggered,
    confidence,
    reason: "r",
    latencyMs: 50,
    usage: { prompt_tokens: tokens - 10, completion_tokens: 10, total_tokens: tokens },
  };
}

test("expandMatrix produces model-major cells and rejects empty axes", () => {
  const cells = expandMatrix({
    imageIds: ["img_1", "img_2"],
    models: ["m1", "m2"],
    variants: VARIANTS,
  });
  assert.equal(cells.length, 8);
  // Model-major: the first half is entirely m1, then all of m2.
  assert.ok(cells.slice(0, 4).every((c) => c.model === "m1"));
  assert.ok(cells.slice(4).every((c) => c.model === "m2"));
  assert.deepEqual(cells[0], { imageId: "img_1", model: "m1", variantId: "pv_a" });
  assert.throws(() => expandMatrix({ imageIds: [], models: ["m"], variants: VARIANTS }), /image/);
  assert.throws(() => expandMatrix({ imageIds: ["i"], models: [], variants: VARIANTS }), /model/);
  assert.throws(() => expandMatrix({ imageIds: ["i"], models: ["m"], variants: [] }), /variant/);
});

test("runEvalMatrix runs every cell and reports monotonic progress", async () => {
  const cells = expandMatrix({
    imageIds: ["img_1", "img_2"],
    models: ["m1"],
    variants: VARIANTS,
  });
  const seenDone = [];
  const seenArgs = [];
  const results = await runEvalMatrix({
    baseUrl: "https://x.test/v1",
    apiKey: "k",
    cells,
    imagesById: IMAGES,
    variantsById: VARIANTS_BY_ID,
    onResult: (_r, done, total) => seenDone.push([done, total]),
    scanFn: async (args) => {
      seenArgs.push(args);
      return okScan({ triggered: true, confidence: 80 });
    },
  });
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r.status === "ok" && r.triggered === true));
  assert.deepEqual(seenDone.map(([d]) => d).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.ok(seenDone.every(([, t]) => t === 4));
  // The variant's mission and instruction reach the scan; threshold is 0 so
  // `triggered` reflects the raw verdict.
  const strict = seenArgs.find((a) => a.mission === "alert on any person");
  assert.equal(strict.optimizedInstruction, "be strict");
  assert.ok(seenArgs.every((a) => a.threshold === 0));
});

test("runEvalMatrix bounds concurrency and actually runs in parallel", async () => {
  const cells = expandMatrix({
    imageIds: ["img_1", "img_2"],
    models: ["m1", "m2"],
    variants: VARIANTS,
  });
  let inFlight = 0;
  let maxInFlight = 0;
  await runEvalMatrix({
    baseUrl: "b",
    apiKey: "k",
    cells,
    imagesById: IMAGES,
    variantsById: VARIANTS_BY_ID,
    concurrency: 2,
    scanFn: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okScan();
    },
  });
  assert.equal(maxInFlight, 2);
});

test("runEvalMatrix records a per-cell error and keeps going", async () => {
  const cells = expandMatrix({
    imageIds: ["img_1", "img_2"],
    models: ["m1"],
    variants: [VARIANTS[0]],
  });
  const results = await runEvalMatrix({
    baseUrl: "b",
    apiKey: "k",
    cells,
    imagesById: IMAGES,
    variantsById: VARIANTS_BY_ID,
    concurrency: 1,
    scanFn: async ({ image }) => {
      if (image === IMAGES.img_1.dataUrl) throw new Error("Provider API 429: slow down");
      return okScan();
    },
  });
  assert.equal(results[0].status, "error");
  assert.match(results[0].error, /429/);
  assert.equal(results[1].status, "ok");
});

test("runEvalMatrix resolves with partial results after an abort", async () => {
  const cells = expandMatrix({
    imageIds: ["img_1", "img_2"],
    models: ["m1", "m2"],
    variants: VARIANTS,
  });
  const controller = new AbortController();
  let calls = 0;
  const results = await runEvalMatrix({
    baseUrl: "b",
    apiKey: "k",
    cells,
    imagesById: IMAGES,
    variantsById: VARIANTS_BY_ID,
    concurrency: 1,
    signal: controller.signal,
    scanFn: async () => {
      calls += 1;
      if (calls === 2) {
        controller.abort();
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return okScan();
    },
  });
  assert.equal(results.length, cells.length);
  assert.equal(results[0].status, "ok");
  // The in-flight cell aborted by Cancel counts as cancelled, not an error.
  assert.equal(results[1].status, "cancelled");
  assert.equal(results[1].error, null);
  assert.ok(results.slice(2).every((r) => r.status === "cancelled"));
  assert.equal(calls, 2);
});

test("summarizeResults scores labeled ok cells only and totals cost", () => {
  const mk = (imageId, model, over) => ({
    imageId,
    model,
    variantId: "pv_a",
    status: "ok",
    triggered: false,
    confidence: 10,
    reason: "r",
    latencyMs: 100,
    usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
    error: null,
    ...over,
  });
  const results = [
    // m1: img_1 labeled true → predicted true (tp), img_2 labeled false → predicted true (fp),
    // img_3 unlabeled, img_4 errored (excluded from everything but errorCount).
    mk("img_1", "m1", { triggered: true, confidence: 90 }),
    mk("img_2", "m1", { triggered: true, confidence: 70 }),
    mk("img_3", "m1", { triggered: false, confidence: 5 }),
    mk("img_4", "m1", { status: "error", triggered: null, confidence: null, latencyMs: null, usage: null, error: "boom" }),
    // m2: all correct.
    mk("img_1", "m2", { triggered: true, confidence: 95, latencyMs: 300 }),
    mk("img_2", "m2", { triggered: false, confidence: 10, latencyMs: 100 }),
  ];
  const expected = { img_1: true, img_2: false, img_3: null };
  const { combos, totals } = summarizeResults(results, expected, "0.10");

  const m1 = combos.find((c) => c.model === "m1");
  assert.equal(m1.n, 4);
  assert.equal(m1.ok, 3);
  assert.equal(m1.errorCount, 1);
  assert.equal(m1.meanLatencyMs, 100);
  assert.equal(m1.totalTokens, 300);
  assert.ok(Math.abs(m1.estCost - (300 / 1e6) * 0.1) < 1e-12);
  assert.deepEqual(
    { n: m1.labeled.n, correct: m1.labeled.correct, tp: m1.labeled.tp, fp: m1.labeled.fp, fn: m1.labeled.fn, tn: m1.labeled.tn },
    { n: 2, correct: 1, tp: 1, fp: 1, fn: 0, tn: 0 },
  );
  assert.equal(m1.labeled.accuracy, 0.5);
  // gaps: |90-100| = 10 and |70-0| = 70 → mean 40
  assert.equal(m1.labeled.meanAbsConfidenceGap, 40);

  const m2 = combos.find((c) => c.model === "m2");
  assert.equal(m2.labeled.accuracy, 1);
  assert.equal(m2.meanLatencyMs, 200);

  assert.equal(totals.totalTokens, 500);
  assert.equal(totals.errorCount, 1);
});

test("summarizeResults leaves labeled null when no labels exist", () => {
  const { combos } = summarizeResults(
    [
      {
        imageId: "img_1", model: "m1", variantId: "pv_a", status: "ok",
        triggered: true, confidence: 50, reason: "r", latencyMs: 10,
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, error: null,
      },
    ],
    { img_1: null },
    0,
  );
  assert.equal(combos[0].labeled, null);
});

test("comboKey distinguishes combos unambiguously", () => {
  assert.notEqual(comboKey("m1", "pv_a"), comboKey("m1", "pv_b"));
  assert.notEqual(comboKey("a", "b c"), comboKey("a b", "c"));
});

test("eval store round-trips images, labels, and the last run", async () => {
  const store = createEvalStore(createMemoryAdapter());
  const a = await store.addImage({ dataUrl: "data:image/jpeg;base64,AAA", source: "upload" });
  const b = await store.addImage({ dataUrl: "data:image/jpeg;base64,BBB", source: "camera" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.expected, null);

  let list = await store.listImages();
  assert.deepEqual(list.map((i) => i.dataUrl), [a.dataUrl, b.dataUrl]);

  const labeled = await store.setImageExpected(a.id, true);
  assert.equal(labeled.expected, true);
  assert.equal((await store.listImages()).find((i) => i.id === a.id).expected, true);
  assert.equal(await store.setImageExpected("missing", true), null);

  await store.removeImage(b.id);
  list = await store.listImages();
  assert.equal(list.length, 1);

  const run = { at: 123, baseUrl: "b", models: ["m1"], results: [] };
  await store.saveLastRun(run);
  const loaded = await store.getLastRun();
  assert.equal(loaded.id, "last");
  assert.equal(loaded.at, 123);

  await store.clearImages();
  assert.deepEqual(await store.listImages(), []);
});

test("eval modules import in Node without an indexedDB global (lazy adapter)", () => {
  // Regression guard: creating the store (with its default IDB adapter) must
  // not touch the indexedDB global until an operation actually runs.
  assert.equal(typeof globalThis.indexedDB, "undefined");
  const store = createEvalStore();
  assert.equal(typeof store.listImages, "function");
});
