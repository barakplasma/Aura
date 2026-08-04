import * as esbuild from "esbuild";
import { copyFile, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  copyFile(
    path.join(root, "src", "aura.css"),
    path.join(root, "public", "aura.css"),
  ),
]);

await buildServiceWorker();

console.log("React bundle built.");

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
