import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comboKey,
  expandMatrix,
  runEvalMatrix,
  summarizeResults,
} from "../lib/eval.js";
import {
  createEvalStore,
  createMemoryAdapter,
} from "../lib/eval-store.js";

const variants = [
  { id: "v1", name: "A", mission: "watch A", instruction: "" },
  { id: "v2", name: "B", mission: "watch B", instruction: "be strict" },
];

test("expandMatrix creates model-major cells and rejects empty inputs", () => {
  const cells = expandMatrix({
    imageIds: ["i1", "i2"],
    models: ["m1", "m2"],
    variants,
  });
  assert.equal(cells.length, 8);
  assert.deepEqual(cells.slice(0, 4), [
    { imageId: "i1", model: "m1", variantId: "v1" },
    { imageId: "i2", model: "m1", variantId: "v1" },
    { imageId: "i1", model: "m1", variantId: "v2" },
    { imageId: "i2", model: "m1", variantId: "v2" },
  ]);
  assert.throws(() => expandMatrix({ imageIds: [], models: ["m"], variants }), /image/);
  assert.throws(() => expandMatrix({ imageIds: ["i"], models: [], variants }), /model/);
  assert.throws(() => expandMatrix({ imageIds: ["i"], models: ["m"], variants: [] }), /variant/);
});

test("summarizeResults scores labeled ok cells and aggregates usage", () => {
  const results = [
    ok("i1", "m1", "v1", true, 92, 100, 120),
    ok("i2", "m1", "v1", true, 60, 200, 80),
    ok("i3", "m1", "v1", false, 20, 300, 0),
    err("i4", "m1", "v1"),
    ok("i1", "m2", "v1", false, 10, 400, 10),
  ];

  const summary = summarizeResults(
    results,
    { i1: true, i2: false, i3: null },
    "0.50",
  );
  const first = summary.combos.find((c) => c.model === "m1");
  assert.equal(first.n, 4);
  assert.equal(first.ok, 3);
  assert.equal(first.errorCount, 1);
  assert.equal(first.triggeredCount, 2);
  assert.equal(first.meanLatencyMs, 200);
  assert.equal(first.totalTokens, 200);
  assert.equal(first.estCost, 0.0001);
  assert.deepEqual(
    pick(first.labeled, ["n", "correct", "tp", "fp", "fn", "tn"]),
    { n: 2, correct: 1, tp: 1, fp: 1, fn: 0, tn: 0 },
  );
  assert.equal(first.labeled.accuracy, 0.5);
  assert.equal(first.labeled.meanAbsConfidenceGap, 34);

  const second = summary.combos.find((c) => c.model === "m2");
  assert.equal(second.labeled.n, 1);
  assert.equal(second.labeled.fn, 1);
  assert.equal(summary.totals.totalTokens, 210);
});

test("summarizeResults leaves all-unlabeled combos unlabeled", () => {
  const summary = summarizeResults([ok("i1", "m1", "v1", false, 0, 10, 5)], {}, 1);
  assert.equal(summary.combos[0].labeled, null);
});

test("runEvalMatrix reports all results and bounds concurrency", async () => {
  const cells = expandMatrix({
    imageIds: ["i1", "i2", "i3", "i4"],
    models: ["m1"],
    variants: [variants[0]],
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const progress = [];
  const results = await runEvalMatrix({
    baseUrl: "http://example.test/v1",
    apiKey: "k",
    cells,
    imagesById: imageMap(["i1", "i2", "i3", "i4"]),
    variantsById: variantMap([variants[0]]),
    concurrency: 2,
    onResult: (_result, done, total) => progress.push([done, total]),
    scanFn: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(20);
      inFlight--;
      return {
        triggered: false,
        confidence: 12,
        reason: "clear",
        latencyMs: 20,
        usage: { total_tokens: 10 },
      };
    },
  });

  assert.equal(results.length, 4);
  assert.equal(results.every((r) => r.status === "ok"), true);
  assert.equal(maxInFlight, 2);
  assert.deepEqual(progress, [
    [1, 4],
    [2, 4],
    [3, 4],
    [4, 4],
  ]);
});

test("runEvalMatrix records one cell error and continues", async () => {
  const cells = expandMatrix({
    imageIds: ["i1", "i2", "i3"],
    models: ["m1"],
    variants: [variants[0]],
  });
  const results = await runEvalMatrix({
    baseUrl: "http://example.test/v1",
    apiKey: "k",
    cells,
    imagesById: imageMap(["i1", "i2", "i3"]),
    variantsById: variantMap([variants[0]]),
    scanFn: async ({ image }) => {
      if (image.includes("i2")) throw new Error("rate limited");
      return {
        triggered: true,
        confidence: 80,
        reason: "hit",
        latencyMs: 5,
        usage: { total_tokens: 1 },
      };
    },
  });
  assert.equal(results.filter((r) => r.status === "ok").length, 2);
  assert.equal(results.find((r) => r.imageId === "i2").status, "error");
  assert.match(results.find((r) => r.imageId === "i2").error, /rate limited/);
});

test("runEvalMatrix resolves partials with cancelled cells on abort", async () => {
  const cells = expandMatrix({
    imageIds: ["i1", "i2", "i3", "i4"],
    models: ["m1"],
    variants: [variants[0]],
  });
  const controller = new AbortController();
  let seenOk = false;
  const results = await runEvalMatrix({
    baseUrl: "http://example.test/v1",
    apiKey: "k",
    cells,
    imagesById: imageMap(["i1", "i2", "i3", "i4"]),
    variantsById: variantMap([variants[0]]),
    concurrency: 2,
    signal: controller.signal,
    onResult: (result) => {
      if (result.status === "ok" && !seenOk) {
        seenOk = true;
        controller.abort();
      }
    },
    scanFn: async ({ signal }) => {
      await delay(10);
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return {
        triggered: false,
        confidence: 1,
        reason: "clear",
        latencyMs: 10,
        usage: { total_tokens: 1 },
      };
    },
  });
  assert.equal(results.filter((r) => r.status === "ok").length, 1);
  assert.equal(results.filter((r) => r.status === "cancelled").length, 3);
});

test("memory eval store supports image CRUD and last run round-trip", async () => {
  const store = createEvalStore({
    imagesAdapter: createMemoryAdapter(),
    runsAdapter: createMemoryAdapter(),
  });
  const image = {
    id: "img_1",
    dataUrl: "data:image/jpeg;base64,aaa",
    expected: null,
    source: "upload",
    createdAt: 1,
  };
  await store.putImage(image);
  assert.deepEqual(await store.getImage("img_1"), image);
  await store.putImage({ ...image, expected: true });
  assert.equal((await store.getImage("img_1")).expected, true);
  assert.equal((await store.listImages()).length, 1);
  await store.deleteImage("img_1");
  assert.equal((await store.listImages()).length, 0);

  const run = { at: 2, results: [ok("i1", "m1", "v1", true, 90, 20, 3)] };
  await store.saveLastRun(run);
  assert.deepEqual(await store.getLastRun(), { ...run, id: "last" });
});

test("eval store module imports in Node without indexedDB", () => {
  assert.equal(typeof createMemoryAdapter, "function");
});

function ok(imageId, model, variantId, triggered, confidence, latencyMs, tokens) {
  return {
    imageId,
    model,
    variantId,
    status: "ok",
    triggered,
    confidence,
    reason: triggered ? "hit" : "clear",
    latencyMs,
    usage: { total_tokens: tokens },
  };
}

function err(imageId, model, variantId) {
  return {
    imageId,
    model,
    variantId,
    status: "error",
    error: "bad",
  };
}

function imageMap(ids) {
  return Object.fromEntries(
    ids.map((id) => [id, { id, dataUrl: `data:image/jpeg;base64,${id}` }]),
  );
}

function variantMap(list) {
  return Object.fromEntries(list.map((variant) => [variant.id, variant]));
}

function pick(obj, keys) {
  return Object.fromEntries(keys.map((key) => [key, obj[key]]));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
