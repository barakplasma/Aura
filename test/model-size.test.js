import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expectedOnnxPaths,
  estimateModelBytes,
  fetchModelSizeEstimate,
} from "../lib/model-size.js";

test("expectedOnnxPaths builds one onnx path per component, suffixed by its dtype", () => {
  const dtype = { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" };
  assert.deepEqual(expectedOnnxPaths(dtype), [
    "onnx/embed_tokens_fp16.onnx",
    "onnx/vision_encoder_q4.onnx",
    "onnx/decoder_model_merged_q4.onnx",
  ]);
});

test("expectedOnnxPaths returns fp32's empty suffix and an unknown dtype's empty suffix the same way", () => {
  assert.deepEqual(expectedOnnxPaths({ model: "fp32" }), ["onnx/model.onnx"]);
  assert.deepEqual(expectedOnnxPaths({ model: "not-a-real-dtype" }), ["onnx/model.onnx"]);
});

test("expectedOnnxPaths returns nothing for a plain-string dtype (no per-component filenames to derive)", () => {
  assert.deepEqual(expectedOnnxPaths("q4"), []);
  assert.deepEqual(expectedOnnxPaths(null), []);
  assert.deepEqual(expectedOnnxPaths(undefined), []);
});

const SAMPLE_TREE = [
  { path: "config.json", size: 500 },
  { path: "tokenizer.json", size: 2_000_000 },
  { path: "tokenizer_config.json", size: 1_200 },
  { path: "README.md", size: 50_000 }, // not .json/.txt — must be excluded
  { path: "model.safetensors", size: 900_000_000 }, // raw weights, never fetched — excluded
  { path: "onnx/embed_tokens_fp16.onnx", size: 40_000_000 },
  { path: "onnx/vision_encoder_q4.onnx", size: 60_000_000 },
  { path: "onnx/decoder_model_merged_q4.onnx", size: 100_000_000 },
  { path: "onnx/embed_tokens_fp32.onnx", size: 80_000_000 }, // different dtype — excluded
];

test("estimateModelBytes sums only the matching onnx weight files plus small root config/tokenizer files", () => {
  const dtype = { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" };
  const total = estimateModelBytes(SAMPLE_TREE, dtype);
  const expected = 500 + 2_000_000 + 1_200 + 40_000_000 + 60_000_000 + 100_000_000;
  assert.equal(total, expected);
});

test("estimateModelBytes returns null when none of the expected onnx files are present", () => {
  const dtype = { embed_tokens: "q8" }; // not in SAMPLE_TREE at all
  assert.equal(estimateModelBytes(SAMPLE_TREE, dtype), null);
});

test("estimateModelBytes with no per-component dtype falls back to just the small config files", () => {
  const total = estimateModelBytes(SAMPLE_TREE, "q4");
  assert.equal(total, 500 + 2_000_000 + 1_200);
});

test("estimateModelBytes ignores malformed entries instead of throwing", () => {
  const dirty = [...SAMPLE_TREE, null, {}, { path: "no-size.json" }, { path: 42, size: 10 }];
  const dtype = { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" };
  assert.equal(estimateModelBytes(dirty, dtype), estimateModelBytes(SAMPLE_TREE, dtype));
});

test("fetchModelSizeEstimate resolves to the estimated total on a successful Hub response", async () => {
  const dtype = { embed_tokens: "fp16", vision_encoder: "q4", decoder_model_merged: "q4" };
  const fakeFetch = async (url) => {
    assert.match(url, /^https:\/\/huggingface\.co\/api\/models\/.+\/tree\/main\?recursive=true$/);
    return { ok: true, json: async () => SAMPLE_TREE };
  };
  const total = await fetchModelSizeEstimate("Some/Model", dtype, fakeFetch);
  assert.equal(total, estimateModelBytes(SAMPLE_TREE, dtype));
});

test("fetchModelSizeEstimate resolves to null (never rejects) on a non-ok response", async () => {
  const fakeFetch = async () => ({ ok: false, json: async () => [] });
  const total = await fetchModelSizeEstimate("Some/Model", { a: "q4" }, fakeFetch);
  assert.equal(total, null);
});

test("fetchModelSizeEstimate resolves to null on a network error or malformed body", async () => {
  const throwingFetch = async () => {
    throw new Error("offline");
  };
  assert.equal(await fetchModelSizeEstimate("Some/Model", { a: "q4" }, throwingFetch), null);

  const malformedFetch = async () => ({ ok: true, json: async () => ({ not: "an array" }) });
  assert.equal(await fetchModelSizeEstimate("Some/Model", { a: "q4" }, malformedFetch), null);
});
