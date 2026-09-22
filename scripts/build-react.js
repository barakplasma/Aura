import * as esbuild from "esbuild";
import { existsSync } from "node:fs";
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
//
// Every WASM variant in dist/ is copied except `jspi` (Node-only). Which one
// the worker instantiates is ORT's choice, not this script's — see the note
// above `wasmPaths` in src/workers/ml.worker.js for why naming the pair is
// wrong in onnxruntime-web 1.31.0-dev.
//
// The version check is the point of this function. The ORT *JavaScript* is
// bundled into ml.worker.js by esbuild, while the WASM it instantiates is
// fetched from public/ort/ at runtime — two paths that can silently disagree,
// because `onnxruntime-web/webgpu` is imported from inside
// @huggingface/transformers, which prefers a nested copy of the package. A WASM
// glue from a different version does not export the init function the bundled
// JS calls, so the BROWSER engine dies at load with
// "no available backend found. ERR: [webgpu] TypeError: … webgpuInit is not a
// function" after every other signal (adapter, limits, isolation) looked fine.
async function copyOnnxRuntimeFiles() {
  const transformersDir = path.join(root, "node_modules", "@huggingface", "transformers");
  const nested = path.join(transformersDir, "node_modules", "onnxruntime-web");
  const ortDir = existsSync(nested)
    ? nested
    : path.join(root, "node_modules", "onnxruntime-web");
  const ortDist = path.join(ortDir, "dist");
  const ortOut = path.join(root, "public", "ort");

  const specs = JSON.parse(
    await readFile(path.join(transformersDir, "package.json"), "utf8"),
  );
  const want = String(specs.dependencies?.["onnxruntime-web"] || "").replace(/^[\^~]/, "");
  const have = JSON.parse(
    await readFile(path.join(ortDir, "package.json"), "utf8"),
  ).version;
  if (want && want !== have) {
    throw new Error(
      `onnxruntime-web version mismatch: @huggingface/transformers wants ${want}, ` +
        `but public/ort would ship ${have} from ${ortDir} — WebGPU init would fail`,
    );
  }

  await rm(ortOut, { recursive: true, force: true });
  await mkdir(ortOut, { recursive: true });
  const all = await readdir(ortDist);
  const files = all.filter(
    (f) => /^ort-wasm-.*\.(wasm|mjs)$/.test(f) && !f.includes("jspi"),
  );
  if (!files.some((f) => f.includes("jsep"))) {
    throw new Error(`no JSEP runtime in ${ortDist} — WebGPU would be unavailable`);
  }
  await Promise.all(
    files.map((f) => copyFile(path.join(ortDist, f), path.join(ortOut, f))),
  );

  // transformers.js resolves its ORT entry points against `import.meta.url`:
  // `new URL("ort.webgpu.bundle.min.mjs", import.meta.url)`. esbuild flattens
  // transformers.js into public/assets/ml.worker.js, so that lookup lands on
  // /assets/ rather than /ort/. With nothing there, the worker throws during
  // module import — before it ever fetches a WASM binary — and the app can
  // only surface "Browser engine worker crashed: unknown error". Ship the
  // loader bundles beside the worker that asks for them. (`/assets/*.mjs` is
  // not precached below, so it is served by plain pass-through, which keeps it
  // COEP-clean without the worker having to synthesise the response.)
  const loaders = all.filter(
    (f) => /^ort(\.[a-z]+)?\.bundle\.min\.mjs$/.test(f) && !f.includes("jspi"),
  );
  if (!loaders.includes("ort.webgpu.bundle.min.mjs")) {
    throw new Error(
      `no WebGPU ORT loader in ${ortDist} — the browser worker would die on import`,
    );
  }
  await mkdir(outdir, { recursive: true });
  await Promise.all(
    loaders.map((f) => copyFile(path.join(ortDist, f), path.join(outdir, f))),
  );
  console.log(
    `ONNX Runtime: ${files.length} files -> public/ort/, ${loaders.length} loaders -> public/assets/`,
  );
}

// Generate public/sw.js from the template with a precache list of the shell
// (every emitted chunk included, so the lazy-loaded screens work offline) and
// a content hash as the version — a new hash is what makes browsers install
// the new worker and refresh the cached assets after a deploy.
async function buildServiceWorker() {
  const publicDir = path.join(root, "public");
  const bundles = (await readdir(outdir))
    .filter((f) => f.endsWith(".js") || f.endsWith(".css")) // skip .map — big, and only devtools wants them
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
