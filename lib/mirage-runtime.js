// Drives the Cactus WASM engine for the `mirage` DECISION row: one engine
// instance per model (the engine owns one process-global model), strings and
// pixels copied into WASM memory by hand (the 4.0.0 glue exports only
// _malloc/_free/HEAPU8/UTF8ToString). Shared by src/workers/mirage.worker.js
// and scripts/dev-mirage.mjs, so the browser and the Node smoke test run the
// same calls. No DOM, no fetch: the caller hands in the factory and bytes.

import { MIRAGE_OPTIONS, NEEDLE_SYSTEM, NEEDLE_TOOLS, buildTarget, parseNeedleTarget } from "./mirage.js";

const OUT_CAP = 1 << 20;

async function instance(createCactus, wasmBinary, cact) {
  const M = await createCactus({ wasmBinary });
  const str = (s) => {
    const b = new TextEncoder().encode(`${s}\0`);
    const p = M._malloc(b.length);
    M.HEAPU8.set(b, p);
    return p;
  };
  const err = () => M.UTF8ToString(M._cactus_last_error()) || "unknown engine error";
  const p = M._malloc(cact.length);
  M.HEAPU8.set(cact, p);
  if (M._cactus_load(p, BigInt(cact.length)) < 0) throw new Error(`Cactus engine could not load the model: ${err()}`);
  M._free(p);
  const out = M._malloc(OUT_CAP);
  // Every call frees what it allocated, so a long session doesn't grow the heap.
  const call = (fn, ...strings) => {
    const ptrs = strings.map((s) => (s == null ? 0 : str(s)));
    try {
      const n = fn(ptrs, out, OUT_CAP);
      if (n < 0) throw new Error(err());
      return JSON.parse(M.UTF8ToString(out));
    } finally {
      for (const q of ptrs) if (q) M._free(q);
    }
  };
  return { M, str, err, call };
}

/**
 * @param {object} deps
 * @param {Function} deps.createCactus  the vendored Emscripten factory
 * @param {Uint8Array} deps.wasmBinary  cactus.wasm
 * @param {(which: "vision"|"text") => Promise<Uint8Array>} deps.loadModel
 */
export function createMirageRuntime({ createCactus, wasmBinary, loadModel }) {
  let vision = null;
  let text = null;
  const targets = new Map();

  // A failed load is forgotten, so the next scan retries it.
  function ensureVision() {
    vision ??= loadModel("vision")
      .then((cact) => instance(createCactus, wasmBinary, cact))
      .catch((err) => {
        vision = null;
        throw err;
      });
    return vision;
  }

  // Needle loads only when a mission it hasn't read comes in, and each
  // mission is read once per session — the mission changes far less often
  // than the frame.
  async function target(mission) {
    const key = String(mission || "").trim();
    if (targets.has(key)) return targets.get(key);
    let needleObject = null;
    try {
      text ??= loadModel("text")
        .then((cact) => instance(createCactus, wasmBinary, cact))
        .then((t) => {
          if (t.M._cactus_init(t.str(NEEDLE_SYSTEM), t.str(JSON.stringify(NEEDLE_TOOLS)), 0) < 0) {
            throw new Error(`Needle 3 init failed: ${t.err()}`);
          }
          return t;
        });
      const t = await text;
      t.M._cactus_reset();
      needleObject = parseNeedleTarget(
        t.call(([input], out, cap) => t.M._cactus_complete(input, 0, 0, 48, out, cap), key),
      );
    } catch (err) {
      // The text model is a helper, not the decision: without it the
      // mission's own COCO words still make a target (buildTarget throws
      // only when there are none). Drop the failed instance so the next
      // mission retries it.
      text = null;
      console.warn("Needle 3 unavailable, using the mission's own words:", err);
    }
    const t = buildTarget({ mission: key, needleObject });
    targets.set(key, t);
    return t;
  }

  async function describe({ rgb, width, height, keywords }) {
    const v = await ensureVision();
    const rp = v.M._malloc(rgb.length);
    v.M.HEAPU8.set(rgb, rp);
    try {
      return v.call(
        ([options, kw], out, cap) => v.M._cactus_describe(rp, width, height, options, 0, kw, out, cap),
        JSON.stringify(MIRAGE_OPTIONS),
        keywords?.length ? keywords.join(",") : null,
      );
    } finally {
      v.M._free(rp);
    }
  }

  // The one scan: mission → target (cached), frame → Mirage record.
  async function scan({ mission, rgb, width, height }) {
    const tgt = await target(mission);
    const started = performance.now();
    const record = await describe({ rgb, width, height, keywords: tgt.keywords });
    return { target: tgt, ...record, timing_ms: { describe: Math.round(performance.now() - started) } };
  }

  return { scan, target, describe, ensureVision };
}
