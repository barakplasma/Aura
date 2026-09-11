// Aura — best-effort total download size for a BROWSER-engine model, so the
// download progress bar (see src/workers/ml.worker.js, the only caller) can
// show a real, monotonically increasing percentage instead of resetting to 0%
// every time transformers.js moves on to the next file.
// Pure and Node-testable: network access is injected via `fetchImpl`.

// Mirrors @huggingface/transformers' DEFAULT_DTYPE_SUFFIX_MAPPING
// (src/utils/dtypes.js) — the filename suffix a dtype maps to for an ONNX
// weight file. Small and stable enough to duplicate rather than reach across
// the bundle boundary this worker is deliberately the only side of (see
// CLAUDE.md's bundle-isolation rule for @huggingface/transformers).
const DTYPE_SUFFIX = {
  fp32: "",
  fp16: "_fp16",
  int8: "_int8",
  uint8: "_uint8",
  q8: "_quantized",
  q4: "_q4",
  q2: "_q2",
  q1: "_q1",
  q4f16: "_q4f16",
  q2f16: "_q2f16",
  q1f16: "_q1f16",
  bnb4: "_bnb4",
};

// The ONNX weight file paths transformers.js will fetch for a per-component
// dtype config (e.g. BROWSER_MODELS' `{ embed_tokens: "fp16", vision_encoder:
// "q4", ... }`) — same naming rule as getCoreModelFile: `onnx/<component>
// <suffix>.onnx`. A plain string dtype (one shared dtype, no per-file map)
// isn't resolvable here without knowing the model's component file names, so
// callers get an empty list and estimateModelBytes() falls through to
// config-files-only sizing.
export function expectedOnnxPaths(dtype, subfolder = "onnx") {
  if (!dtype || typeof dtype !== "object") return [];
  return Object.entries(dtype).map(
    ([component, t]) => `${subfolder}/${component}${DTYPE_SUFFIX[t] ?? ""}.onnx`,
  );
}

// Sums the sizes of the exact ONNX weight files this dtype config will
// fetch, plus every small root-level config/tokenizer file (.json/.txt) —
// those are always fetched regardless of dtype, and overcounting them by a
// few KB against ~100MB+ weight files is negligible. `entries` is the Hub's
// recursive file-tree listing: [{ path, size }, ...]. Returns null when none
// of the expected ONNX files were found (wrong dtype keys, repo layout
// changed) rather than silently reporting a size that's missing the bulk of
// the download.
export function estimateModelBytes(entries, dtype) {
  const wanted = new Set(expectedOnnxPaths(dtype));
  let total = 0;
  let matchedAnyOnnx = wanted.size === 0;
  for (const entry of entries || []) {
    if (!entry || typeof entry.path !== "string" || !Number.isFinite(entry.size)) continue;
    if (wanted.has(entry.path) || wanted.has(externalDataParent(entry.path))) {
      total += entry.size;
      matchedAnyOnnx = true;
    } else if (!entry.path.includes("/") && /\.(json|txt)$/.test(entry.path)) {
      total += entry.size;
    }
  }
  return matchedAnyOnnx ? total : null;
}

// Models over the 2 GB protobuf limit — and some well under it, including
// LFM2.5-VL — keep their weights in sibling `<file>.onnx_data` files, leaving
// the `.onnx` itself a few hundred KB of graph. Counting only the `.onnx`
// would size an 810 MB download at under a megabyte, which makes the progress
// bar report 4000% and finish instantly. transformers.js names the chunks
// `<name>.onnx_data`, `<name>.onnx_data_1`, ... (getExternalDataChunkNames),
// so map any of those back to the `.onnx` the dtype config asked for.
export function externalDataParent(path) {
  const m = /^(.*\.onnx)_data(?:_\d+)?$/.exec(path);
  return m ? m[1] : null;
}

// Fetches the repo's file tree from the public Hugging Face Hub API and
// estimates total download bytes for the given dtype config. Best-effort:
// resolves to null on any failure (offline, blocked, private repo, unknown
// model) rather than rejecting, so a slow or unreachable Hub never delays or
// breaks the actual model load in ml.worker.js — it only degrades the
// progress bar back to per-file percentages.
export async function fetchModelSizeEstimate(modelId, dtype, fetchImpl = fetch) {
  try {
    const url = `https://huggingface.co/api/models/${modelId}/tree/main?recursive=true`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const entries = await res.json();
    if (!Array.isArray(entries)) return null;
    return estimateModelBytes(entries, dtype);
  } catch {
    return null;
  }
}
