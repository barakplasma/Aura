#!/usr/bin/env node
// Dev instrument: proves which execution provider the ML worker's ONNX session
// actually got.
//
// Why: the app's status line reports the WebGPU *adapter* and its limits, which
// `lib/webgpu-limits.js` requests before the first session exists. That number
// looked like proof of GPU inference while the graphs were running on one CPU
// thread, because scripts/build-react.js shipped the asyncify (no-JSEP) runtime
// and an ORT session cannot drive WebGPU without JSEP. Adapter limits and
// session provider are different facts; only the worker's own console says
// which provider won.
//
// Setup:
//   ~/bin/adb forward tcp:9222 localabstract:chrome_devtools_remote
//
// Usage:
//   node scripts/dev-ep-watch.mjs            # ~3 min
//   SECONDS=600 node scripts/dev-ep-watch.mjs
//
// Attach/detach from the ml.worker target is what a page console patch cannot
// do: the worker is created by useMonitor after load, is replaced on every
// model change, and its console messages are not forwarded to the page.

const CDP = process.env.CDP_BASE || "http://127.0.0.1:9222";
const SECONDS = Number(process.env.SECONDS || 180);
const DEADLINE = Date.now() + SECONDS * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Lines that identify the provider, plus the failures that explain a fallback.
const INTEREST =
  /webgpu|wasm|jsep|cpu|fallback|provider|session|adapter|limit|error|failed|abort|transformers|dtype|quant/i;

async function targets() {
  try {
    return await (await fetch(`${CDP}/json`)).json();
  } catch {
    return [];
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && waiting.has(d.id)) {
        const { ok } = waiting.get(d.id);
        waiting.delete(d.id);
        ok(d.result);
      } else if (d.method === "Runtime.consoleAPICalled") {
        const text = (d.params?.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
          .join(" ");
        if (INTEREST.test(text)) emit(d.params.type, text);
      } else if (d.method === "Runtime.exceptionThrown") {
        emit("exception", d.params?.exceptionDetails?.exception?.description || "exception");
      }
    };
    ws.onerror = () => reject(new Error(`ws error ${url}`));
    ws.onopen = () =>
      resolve({
        ws,
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((ok) => {
            waiting.set(mid, { ok });
            setTimeout(() => waiting.delete(mid), 10_000);
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
      });
  });
}

function emit(kind, text) {
  const line = `${new Date().toLocaleTimeString()} [${kind}] ${text.replace(/\s+/g, " ").slice(0, 220)}`;
  console.log(line);
}

const seen = new Map(); // targetId -> ws
while (Date.now() < DEADLINE) {
  for (const t of await targets()) {
    if (t.type !== "worker" || !t.webSocketDebuggerUrl) continue;
    if (seen.has(t.url)) continue;
    seen.set(t.url, true);
    console.log(`--- worker ${t.targetId} ${t.url.slice(0, 60)}`);
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      await c.send("Runtime.enable");
      // A worker already past its model load has printed its provider line, so
      // ask for the state we can still read: what ORT reports about itself.
      await c
        .send("Runtime.evaluate", {
          expression: `(async () => {
            const o = globalThis.ort || (globalThis.__ort__);
            const g = await navigator.gpu?.requestAdapter?.();
            const lim = g ? { storage: g.limits.maxStorageBufferBindingSize } : null;
            return JSON.stringify({ ort: o ? { version: o.version, wasm: !!o.env?.backends?.wasm } : null, adapter: !!g, limits: lim });
          })()`,
          returnByValue: true,
          awaitPromise: true,
        })
        .then((r) => {
          if (r?.result?.value) emit("state", r.result.value);
        });
    } catch (e) {
      emit("watcher-error", String(e.message).slice(0, 120));
    }
  }
  await sleep(3_000);
}
console.log("--- watch window over");
