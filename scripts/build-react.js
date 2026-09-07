import * as esbuild from "esbuild";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const dir = import.meta.dirname;
const root = path.join(dir, "..");
const outdir = path.join(root, "public", "assets");

// Purge stale hashed chunks from previous builds.
await rm(outdir, { recursive: true, force: true });

await Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, "src", "main.jsx")],
    outdir,
    entryNames: "app",
    chunkNames: "chunk-[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    jsx: "automatic",
    jsxImportSource: "react",
    minify: true,
    // External maps keep the deployed app debuggable; browsers only fetch
    // them when devtools is open, so users never pay for them.
    sourcemap: "linked",
  }),
  // Separate entry point: the ONLY bundle that pulls in
  // @huggingface/transformers (see CLAUDE.md's bundle rule). No splitting —
  // a worker script is a single file, not a lazily-loaded chunk graph.
  esbuild.build({
    entryPoints: [path.join(root, "src", "workers", "ml.worker.js")],
    outdir,
    entryNames: "ml.worker",
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    sourcemap: "linked",
  }),
  copyFile(
    path.join(root, "src", "aura.css"),
    path.join(root, "public", "aura.css"),
  ),
  copyOnnxRuntimeFiles(),
]);

await buildServiceWorker();

console.log("React bundle built.");

// The BROWSER engine's worker points ONNX Runtime Web at these same-origin
// files (env.backends.onnx.wasm.wasmPaths in src/workers/ml.worker.js)
// instead of its default CDN, so the app keeps working offline once cached.
// onnxruntime-web ships one universal WASM binary (SIMD + threading + JSEP/
// WebGPU support merged) — copy just that pair rather than the whole dist/.
async function copyOnnxRuntimeFiles() {
  const ortDist = path.join(root, "node_modules", "onnxruntime-web", "dist");
  const ortOut = path.join(root, "public", "ort");
  await rm(ortOut, { recursive: true, force: true });
  await mkdir(ortOut, { recursive: true });
  const files = [
    "ort-wasm-simd-threaded.asyncify.wasm",
    "ort-wasm-simd-threaded.asyncify.mjs",
  ];
  await Promise.all(
    files.map((f) => copyFile(path.join(ortDist, f), path.join(ortOut, f))),
  );
}

// Generate public/sw.js from the template with a precache list of the shell
// (every emitted chunk included, so the lazy-loaded screens work offline) and
// a content hash as the version — a new hash is what makes browsers install
// the new worker and refresh the cached assets after a deploy.
async function buildServiceWorker() {
  const publicDir = path.join(root, "public");
  const bundles = (await readdir(outdir))
    .filter((f) => f.endsWith(".js")) // skip .map — big, and only devtools wants them
    .sort()
    .map((f) => `assets/${f}`);
  const icons = (await readdir(path.join(publicDir, "icons")))
    .sort()
    .map((f) => `icons/${f}`);
  const precache = [
    "index.html",
    "aura.css",
    "manifest.webmanifest",
    ...icons,
    ...bundles,
  ];

  const hash = createHash("sha256");
  for (const rel of precache) {
    hash.update(rel);
    hash.update(await readFile(path.join(publicDir, rel)));
  }

  // Hand-built array literal rather than JSON.stringify so the emitted file is
  // Prettier-clean (trailing comma) and doesn't trip the repo's linters.
  const list = `[\n${precache.map((p) => `  ${JSON.stringify(p)},\n`).join("")}]`;
  const template = await readFile(path.join(dir, "sw-template.js"), "utf8");
  const sw = template
    .replace("__VERSION__", hash.digest("hex").slice(0, 12))
    .replace("__PRECACHE__", list);
  await writeFile(path.join(publicDir, "sw.js"), sw);
}
