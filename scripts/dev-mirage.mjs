// Real-inference smoke test for the `mirage` DECISION row, in Node: the
// vendored Cactus engine, the pinned Mirage + Needle 3 weights (downloaded
// once into MIRAGE_CACHE, hash-checked), the same lib/mirage-runtime.js the
// browser worker runs, and lib/decision.js's adapter on top.
//
//   node scripts/dev-mirage.mjs <image> "<mission>" [<image> "<mission>" ...]
//   MIRAGE_CACHE=/tmp/mirage node scripts/dev-mirage.mjs photo.jpg "tell me when a cat is on the bed"
//
// Frames are resized to 640×480 like Aura's capture.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import createCactus from "../vendor/cactus/cactus.js";
import { MIRAGE_ASSETS } from "../lib/mirage.js";
import { createMirageRuntime } from "../lib/mirage-runtime.js";
import { scanDecision } from "../lib/decision.js";

const root = path.join(import.meta.dirname, "..");
const cacheDir = process.env.MIRAGE_CACHE || path.join(root, "node_modules", ".cache", "mirage");
const args = process.argv.slice(2);
if (args.length < 2 || args.length % 2) {
  console.error('usage: node scripts/dev-mirage.mjs <image> "<mission>" [...]');
  process.exit(2);
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

async function loadModel(which) {
  const a = MIRAGE_ASSETS[which];
  const file = path.join(cacheDir, `${a.sha256}.cact`);
  if (!existsSync(file)) {
    console.log(`downloading ${which} (${(a.bytes / 1e6).toFixed(1)} MB)…`);
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`${a.url}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (sha256(buf) !== a.sha256) throw new Error(`${which}: hash mismatch`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, buf);
  }
  return new Uint8Array(await readFile(file));
}

const wasmBinary = new Uint8Array(await readFile(path.join(root, "vendor", "cactus", "cactus.wasm")));
if (sha256(wasmBinary) !== MIRAGE_ASSETS.engine.sha256) throw new Error("vendored cactus.wasm hash mismatch");
const runtime = createMirageRuntime({ createCactus, wasmBinary, loadModel });

for (let i = 0; i < args.length; i += 2) {
  const [image, mission] = [args[i], args[i + 1]];
  const { data } = await sharp(image).removeAlpha().resize(640, 480, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const jpeg = await sharp(image).resize(640, 480, { fit: "fill" }).jpeg().toBuffer();
  const t = performance.now();
  const result = await scanDecision({
    modelId: "mirage",
    mission,
    image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    threshold: 0,
    action: "",
    // Node has no Worker: decode here and call the runtime directly.
    localImpl: async (req) => runtime.scan({ mission: req.mission, rgb: new Uint8Array(data), width: 640, height: 480 }),
  });
  console.log(
    `${path.basename(image)} | ${mission}\n  → ${result.triggered ? "ALERT" : "quiet"} conf ${result.confidence} · ${result.reason}` +
      `\n  target ${JSON.stringify(result.decision.target)} · ${Math.round(performance.now() - t)} ms`,
  );
}
