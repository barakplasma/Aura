// Aura object-gate detector table — see docs/PRD-object-gate.md.
//
// Same posture as lib/browser-models.js: the detector is *data*, not control
// flow. A different detector (a newer YOLO, an Apache-2.0 RT-DETR export) is a
// row here, never a branch in src/workers/ml.worker.js.
//
// These models are NOT vision-language models and never produce an alert. They
// answer one question — "which of 80 COCO objects are in this frame, and
// where" — cheaply enough to run every couple of seconds on a phone, so the
// 450M VLM only has to run when that answer changes.
//
// Kept free of Worker/DOM/Transformers.js imports so it's testable under
// `node --test`.

export const DETECTOR_MODELS = {
  // --- Default ------------------------------------------------------------
  // int8 is the only row cheap enough to be tolerable on the WASM backend,
  // which is what a phone without WebGPU (or one whose adapter refused a
  // device) falls back to. YOLO26's end-to-end head means the export is
  // already NMS-free: 300 one-to-one queries, no JavaScript post-processing
  // beyond a sigmoid and an argmax.
  "yolo26n-int8": {
    modelId: "onnx-community/yolo26n-ONNX",
    label: "YOLO26n · int8",
    sizeLabel: "~2.9 MB",
    downloadBytes: 2.9e6,
    dtype: "int8",
    inputSize: 640,
    requiresWebGpu: false,
    autoSelectable: true,
  },

  // fp16 is the WebGPU-native precision, so this is the better row when the
  // device has an adapter — nearly twice the bytes, still under 1 % of the
  // VLM's download.
  "yolo26n-fp16": {
    modelId: "onnx-community/yolo26n-ONNX",
    label: "YOLO26n · fp16",
    sizeLabel: "~5.0 MB",
    downloadBytes: 5.0e6,
    dtype: "fp16",
    inputSize: 640,
    requiresWebGpu: true,
    autoSelectable: true,
  },

  // --- Opt-in -------------------------------------------------------------
  // Reference precision. Useful when a quantized row disagrees with the
  // desktop `ultralytics` output and you need to know which half is lying.
  "yolo26n-fp32": {
    modelId: "onnx-community/yolo26n-ONNX",
    label: "YOLO26n · fp32",
    sizeLabel: "~9.9 MB",
    downloadBytes: 9.9e6,
    dtype: "fp32",
    inputSize: 640,
    requiresWebGpu: false,
    autoSelectable: false,
  },

  // The small model, for cameras where the interesting object is far away.
  // Not auto-selected: 4x the download and ~3x the compute of the n rows buys
  // accuracy that only a distant-subject camera actually needs.
  "yolo26s-fp16": {
    modelId: "onnx-community/yolo26s-ONNX",
    label: "YOLO26s · fp16",
    sizeLabel: "~20 MB",
    downloadBytes: 20e6,
    dtype: "fp16",
    inputSize: 640,
    requiresWebGpu: true,
    autoSelectable: false,
  },
};

export const DEFAULT_DETECTOR_MODEL = "yolo26n-int8";

/** Detector keys, ascending by download size. */
export function detectorModelKeys() {
  return Object.keys(DETECTOR_MODELS).sort(
    (a, b) => DETECTOR_MODELS[a].downloadBytes - DETECTOR_MODELS[b].downloadBytes,
  );
}

/** Descriptor for a key, or null. Never throws on unknown input. */
export function getDetectorModel(key) {
  return DETECTOR_MODELS[key] ?? null;
}

/**
 * Pick a detector for this device. Unlike pickBrowserModel() there is no
 * memory pressure to reason about — every row here is a rounding error next to
 * the VLM — so the only question is which precision the backend runs best.
 */
export function pickDetectorModel(env = {}) {
  const { hasWebGpu = false } = env;
  if (!hasWebGpu) return "yolo26n-int8";
  return "yolo26n-fp16";
}

// The COCO-80 label set, in class-index order — the same list the ONNX
// export's config.json carries as id2label. This is the detector's entire
// vocabulary: anything not on this list is invisible to the gate, which is
// why the gate can never be the only thing standing between the operator and
// an alert (see the heartbeat in lib/object-gate.js).
export const COCO_LABELS = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
  "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
  "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
  "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
  "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
  "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
  "refrigerator", "book", "clock", "vase", "scissors", "teddy bear",
  "hair drier", "toothbrush",
];

// Words an operator actually writes in a mission, mapped to the COCO classes
// that could represent them. Deliberately small and obvious: this drives a
// *suggestion* the operator edits, never a silent filter, because a wrong
// class filter is a false-negative generator.
const SYNONYMS = {
  person: ["person"],
  people: ["person"],
  someone: ["person"],
  anyone: ["person"],
  somebody: ["person"],
  human: ["person"],
  intruder: ["person"],
  burglar: ["person"],
  stranger: ["person"],
  visitor: ["person"],
  courier: ["person"],
  delivery: ["person", "backpack", "suitcase", "handbag"],
  parcel: ["backpack", "suitcase", "handbag"],
  package: ["backpack", "suitcase", "handbag"],
  box: ["backpack", "suitcase", "handbag"],
  vehicle: ["car", "truck", "bus", "motorcycle"],
  van: ["truck", "car"],
  lorry: ["truck"],
  bike: ["bicycle", "motorcycle"],
  motorbike: ["motorcycle"],
  scooter: ["motorcycle"],
  pet: ["cat", "dog", "bird"],
  kitten: ["cat"],
  puppy: ["dog"],
  phone: ["cell phone"],
  mobile: ["cell phone"],
  tv: ["tv"],
  television: ["tv"],
  screen: ["tv", "laptop"],
  computer: ["laptop"],
  plant: ["potted plant"],
  table: ["dining table"],
  sofa: ["couch"],
  luggage: ["suitcase", "backpack", "handbag"],
  bag: ["handbag", "backpack", "suitcase"],
  drink: ["cup", "bottle", "wine glass"],
  food: ["pizza", "sandwich", "banana", "apple", "bowl"],
};

/**
 * Classes worth watching for a given mission, as a suggestion.
 *
 * Matches COCO labels and the synonym table above against the mission text.
 * Returns [] when nothing matches — which the UI must read as "we have no
 * suggestion", never as "watch nothing".
 */
export function suggestClasses(mission) {
  const text = ` ${String(mission || "").toLowerCase()} `;
  const hits = new Set();
  for (const label of COCO_LABELS) {
    // Word-ish boundary match so "car" doesn't fire on "carpet" and "bear"
    // doesn't fire on "beard". Multi-word labels ("cell phone") match as-is.
    if (new RegExp(`(^|[^a-z])${escapeRe(label)}s?([^a-z]|$)`).test(text))
      hits.add(label);
  }
  for (const [word, labels] of Object.entries(SYNONYMS)) {
    if (new RegExp(`(^|[^a-z])${escapeRe(word)}s?([^a-z]|$)`).test(text))
      for (const l of labels) hits.add(l);
  }
  return [...hits];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse the operator's comma/newline-separated watch list into valid COCO
 * labels. Unknown words are dropped rather than throwing — this reads a
 * free-text field. An empty result means "watch everything".
 */
export function parseClassFilter(raw) {
  const wanted = String(raw || "")
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) return null;
  const valid = wanted.filter((w) => COCO_LABELS.includes(w));
  return valid.length > 0 ? valid : null;
}
