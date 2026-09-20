// e2e harness bridge: runs a browser worker module (src/workers/ml.worker.js)
// in-process under Node behind the browser Worker interface.
//
// browser-engine.js accepts a worker implementation via its _setWorkerFactory()
// test seam; this shim is what the e2e harness hands it. The worker module
// itself stays untouched — it registers through self.addEventListener /
// self.postMessage exactly as it does in a browser, so the shim installs
// those globals before importing it and tears them down on terminate().
//
// The one deliberate adaptation, applied in transit: a load message asking
// for device 'wasm' is delivered as 'cpu'. Node has no WebGPU, and
// onnxruntime-node's native CPU execution provider is both correct and much
// faster than the WASM backend. Only 'load' is rewritten — scan traffic must
// pass through byte-for-byte, which the tests pin.

const installed = { done: false };

// Globals the worker module expects. Installed once; only the *current* shim
// instance is wired to the bridge, so two live shims can't cross-deliver.
function installGlobals() {
  if (installed.done) return;
  installed.done = true;
  if (!globalThis.self) globalThis.self = globalThis;
  self.addEventListener = () => {};
  self.postMessage = (msg) => current?.deliver(msg);
}

// Creates are serialized: importing a worker module mutates the shared
// globals while it registers its handlers, so two concurrent creates would
// interleave those registrations.
let chain = Promise.resolve();
let seq = 0;
let current = null;

export function createNodeWorkerShim(workerModuleUrl) {
  const run = chain.then(async () => {
    installGlobals();
    const moduleUrl = new URL(workerModuleUrl, import.meta.url);
    // Cache-bust so a fresh shim always means a fresh module run — the ESM
    // loader would otherwise hand back the previous instance's registrations.
    moduleUrl.searchParams.set("shim", String(++seq));

    const shim = {
      terminated: false,
      inHandlers: [],
      outHandlers: [],
      deliver(msg) {
        if (shim.terminated) return;
        for (const fn of [...shim.outHandlers]) fn({ data: msg });
      },
      postMessage(msg) {
        if (shim.terminated) return;
        const data =
          msg?.type === "load" && msg.device === "wasm"
            ? { ...msg, device: "cpu" }
            : msg;
        for (const fn of [...shim.inHandlers]) fn({ data });
      },
      addEventListener(type, fn) {
        if (type === "message") shim.outHandlers.push(fn);
      },
      terminate() {
        shim.terminated = true;
        shim.inHandlers = [];
        shim.outHandlers = [];
        if (current === shim) current = null;
      },
    };

    // Route the module's registrations to this shim while it imports.
    self.addEventListener = (type, fn) => {
      if (type === "message") shim.inHandlers.push(fn);
    };
    self.location = new URL(".", moduleUrl);
    current = shim;
    try {
      await import(moduleUrl.href);
    } finally {
      self.addEventListener = () => {};
      if (current === shim && shim.inHandlers.length === 0) current = null;
    }
    return shim;
  });
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}
