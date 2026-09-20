// Minimal stand-in for src/workers/ml.worker.js in node-worker-shim unit
// tests. It registers exactly the way the real worker does —
// self.addEventListener("message") / self.postMessage — and echoes back what
// it received, so the test can see the exact message the shim delivered
// (including the load-device rewrite) without loading a model.

// Guarded so a bare `node --test` sweep (which imports every file under
// test/) doesn't crash on the missing `self` — it only registers when the
// shim has installed the browser worker globals.
if (typeof self !== "undefined") {
  self.addEventListener("message", (event) => {
    const { id, type, device } = event.data || {};
    self.postMessage({ id, type: "echo", sawType: type, sawDevice: device });
  });
}
