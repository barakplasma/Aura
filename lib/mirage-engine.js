// Main-thread facade for the `mirage` DECISION row: posts each scan to
// assets/mirage.worker.js and resolves with the worker's record. Statically
// imported (via lib/decision.js), so it touches no DOM until the first scan
// and never imports the engine itself — the vendored Cactus glue and the
// weights only ever load inside the worker.

let worker = null;
let seq = 0;
const pending = new Map();

// Same plain-URL pattern as lib/browser-engine.js, so esbuild never inlines
// the worker's graph into the main bundle.
function defaultWorkerFactory() {
  return new Worker(new URL("assets/mirage.worker.js", document.baseURI), { type: "module" });
}
let workerFactory = defaultWorkerFactory;

// Test hook — inject a fake worker (postMessage / onmessage / onerror /
// terminate); drops the current one so the next scan uses the new factory.
export function _setMirageWorkerFactory(factory) {
  workerFactory = factory || defaultWorkerFactory;
  failAll("Mirage worker replaced.");
}

// A crash or a hung call fails every waiting scan and drops the worker; the
// next scan starts a fresh one (weights come back from Cache Storage).
function failAll(message) {
  const waiting = [...pending.values()];
  pending.clear();
  try {
    worker?.terminate();
  } catch {
    // already gone
  }
  worker = null;
  for (const p of waiting) p.reject(new Error(message));
}

function ensureWorker() {
  if (worker) return worker;
  worker = workerFactory();
  worker.onmessage = ({ data }) => {
    const p = pending.get(data?.id);
    if (!p) return;
    if (data.type === "progress") return p.progress(data);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.result);
  };
  worker.onerror = (e) => {
    e?.preventDefault?.();
    failAll(`Mirage worker crashed: ${e?.message || "unknown error"}`);
  };
  return worker;
}

/**
 * Run one Mirage scan on this device.
 * @param {{image: string, mission: string}} request  from the `mirage` adapter
 * @param {{signal?: AbortSignal, timeoutMs?: number|null, onProgress?: Function}} opts
 *   timeoutMs bounds inference only — it starts when the worker says the
 *   models are loaded, so a first-run download is never cut short.
 */
export function runMirage(request, { signal, timeoutMs = null, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const id = ++seq;
    let timer = null;
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      pending.delete(id);
      fn(value);
    };
    // WASM can't be interrupted mid-call; an aborted scan's result is dropped.
    const onAbort = () => settle(reject)(signal.reason ?? new DOMException("Aborted", "AbortError"));
    pending.set(id, {
      resolve: settle(resolve),
      reject: settle(reject),
      progress(msg) {
        if (msg.phase === "inference" && timeoutMs && !timer) {
          timer = setTimeout(
            () => failAll(`Mirage took longer than ${Math.round(timeoutMs / 1000)}s on this device.`),
            timeoutMs,
          );
        }
        onProgress?.(msg);
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    ensureWorker().postMessage({ id, type: "scan", image: request.image, mission: request.mission });
  });
}
