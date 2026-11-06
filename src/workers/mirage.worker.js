// The `mirage` DECISION row's worker (lib/mirage.js): runs the vendored
// Cactus WASM engine with Mirage (vision) and Needle 3 (text). The only file
// that imports vendor/cactus/cactus.js — built as its own esbuild entry by
// scripts/build-react.js, like ml.worker.js.
//
// Every artifact is hash-checked before it reaches the engine and kept in
// Cache Storage, so after the first scan the row works offline.

import createCactus from "../../vendor/cactus/cactus.js";
import { MIRAGE_ASSETS } from "../../lib/mirage.js";
import { createMirageRuntime } from "../../lib/mirage-runtime.js";

const CACHE = "aura-mirage-v1";
const LABELS = { vision: "Mirage", text: "Needle 3" };

let report = () => {};

async function sha256(buf) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Cache first, then the network with streamed progress. A bad hash is never
// cached and never loaded.
async function fetchPinned(url, asset, label) {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url).catch(() => null);
  let buf;
  if (hit) {
    buf = new Uint8Array(await hit.arrayBuffer());
  } else {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`Downloading ${label} failed: HTTP ${res.status}`);
    const chunks = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      report({ phase: "download", file: label, pct: Math.min(99, Math.round((100 * got) / asset.bytes)) });
    }
    buf = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) {
      buf.set(c, at);
      at += c.length;
    }
  }
  if ((await sha256(buf)) !== asset.sha256) {
    await cache?.delete(url).catch(() => {});
    throw new Error(`${label} failed its integrity check — not loading it.`);
  }
  if (!hit) await cache?.put(url, new Response(buf)).catch(() => {});
  return buf;
}

let runtime = null;
async function getRuntime() {
  if (runtime) return runtime;
  // Resolved against this worker's URL (assets/) — the build copies the
  // engine to public/cactus/.
  const engineUrl = new URL(`../${MIRAGE_ASSETS.engine.path}`, self.location.href).href;
  const wasmBinary = await fetchPinned(engineUrl, MIRAGE_ASSETS.engine, "Cactus engine");
  runtime = createMirageRuntime({
    createCactus,
    wasmBinary,
    loadModel: (which) => fetchPinned(MIRAGE_ASSETS[which].url, MIRAGE_ASSETS[which], LABELS[which]),
  });
  return runtime;
}

// Aura's frame (a JPEG data URL) → packed RGB, at its own size.
async function decode(image) {
  const bmp = await createImageBitmap(await (await fetch(image)).blob());
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { rgb, width: canvas.width, height: canvas.height };
}

// One engine call at a time — it's single-threaded and process-global.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data?.type !== "scan") return;
  const { id } = data;
  queue = queue.then(async () => {
    report = (msg) => self.postMessage({ id, type: "progress", ...msg });
    try {
      const rt = await getRuntime();
      const [frame] = await Promise.all([decode(data.image), rt.ensureVision(), rt.target(data.mission)]);
      report({ phase: "inference" });
      const result = await rt.scan({ mission: data.mission, ...frame });
      self.postMessage({ id, type: "result", result });
    } catch (err) {
      self.postMessage({ id, type: "result", error: String(err?.message || err) });
    } finally {
      report = () => {};
    }
  });
};
