# Cactus runtime 4.0.0 (WASM)

`cactus.js` and `cactus.wasm` from
[Cactus-Compute/cactus](https://huggingface.co/Cactus-Compute/cactus) at revision
`1a028f5a3972b67dd8d8752f882113d475e7ec4c`, path `releases/4.0.0/wasm/`, unmodified.
Apache-2.0 (`LICENSE`). SHA-256, matching the release's `manifest.json`:

| File          | SHA-256                                                            |
|---------------|--------------------------------------------------------------------|
| `cactus.js`   | `bb61bcf0c48712bfb9cd0ade8f0748889dfde9944ac308220f42afbc605f82bc` |
| `cactus.wasm` | `4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6` |

Vendored so the DECISION engine's default row (`mirage`, see `lib/mirage.js`) ships
inside the PWA: `scripts/build-react.js` bundles `cactus.js` into
`assets/mirage.worker.js` and copies `cactus.wasm` to `public/cactus/`. Only the
model weights come from the Hub, at pinned revisions with hashes in `lib/mirage.js`.
Single-threaded CPU build: no pthreads, no `SharedArrayBuffer`, no WebGPU.

To upgrade, replace both files from a newer release folder, update the hashes here
and in `MIRAGE_ASSETS.engine`, and run `node scripts/dev-mirage.mjs`.
