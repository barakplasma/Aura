// Where ONNX Runtime Web's WASM comes from, decided before any model download.
//
// Aura serves ORT same-origin (public/ort/, copied by scripts/build-react.js)
// so the BROWSER engine works offline. A host can still be missing files:
// Cloudflare Pages caps files at 25 MiB, so PR previews drop the 27–28 MB
// jsep/asyncify builds, and its SPA fallback answers the missing path with
// index.html. ORT then failed only *after* the model download, with
// "expected magic word 00 61 73 6d, found 3c 21 44 4f" — `<!DO`.
//
// So the first bytes of each WebGPU build are checked up front. Missing →
// the identical build on jsDelivr, the way media-clusterer ships on Pages
// (same version, CORS + CORP cross-origin, so COEP allows it). Neither →
// throw before a single model byte is fetched.

const MAGIC = [0x00, 0x61, 0x73, 0x6d]; // "\0asm"

// The builds ORT picks between for WebGPU; the plain one is under the limit.
export const ORT_WEBGPU_FILES = ["ort-wasm-simd-threaded.asyncify.wasm", "ort-wasm-simd-threaded.jsep.wasm"];

export function isWasm(bytes) {
  return Boolean(bytes && bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b));
}

export function ortCdnBase(version) {
  return `https://cdn.jsdelivr.net/npm/onnxruntime-web@${version}/dist/`;
}

// The first chunk only; the reader is cancelled so a 28 MB file isn't pulled
// just to read four bytes.
async function firstBytes(url, fetchImpl) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    return value ?? null;
  } catch {
    return null;
  }
}

async function servesWasm(base, fetchImpl) {
  const heads = await Promise.all(ORT_WEBGPU_FILES.map((f) => firstBytes(new URL(f, base).href, fetchImpl)));
  return heads.every(isWasm);
}

/**
 * @param {{ local: string, version?: string, fetchImpl?: typeof fetch }} args
 *   local: the same-origin wasmPaths prefix; version: env.backends.onnx.versions.web
 * @returns {Promise<{ base: string, source: "local" | "cdn" }>}
 */
export async function resolveOrtBase({ local, version, fetchImpl = globalThis.fetch }) {
  if (await servesWasm(local, fetchImpl)) return { base: local, source: "local" };
  if (version) {
    const cdn = ortCdnBase(version);
    if (await servesWasm(cdn, fetchImpl)) return { base: cdn, source: "cdn" };
  }
  throw new Error(
    `This deployment doesn't serve ONNX Runtime's WebGPU files (${ORT_WEBGPU_FILES.join(", ")})` +
      `${version ? ` and the jsDelivr copy of ${version} is unreachable` : ""} — nothing was downloaded.`,
  );
}
