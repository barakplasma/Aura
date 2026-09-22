#!/usr/bin/env node
// Dev instrument: measured inference latency per BROWSER_MODELS row on a real
// phone, over raw CDP. Answers "what is p90 for model X" with a number that has
// an n next to it, instead of a cadence guessed from the status line.
//
// Why a script and not the app: lib/stats.js keeps latency samples in a ref
// inside useMonitor (st.samples), so they die with the page and are never
// grouped by model. This wraps the worker's own messages instead — the outbound
// `scan` carries `maxNewTokens`, which is exactly what distinguishes a detection
// call from an action call, and the inbound `result` carries `latencyMs`.
//
// Setup (this VM + reference phone):
//   ~/bin/adb forward tcp:9222 localabstract:chrome_devtools_remote
//   ~/bin/adb reverse tcp:3000 tcp:3000
// then open http://localhost:3000 in Chrome on the phone and unlock the screen.
//
// Usage:
//   node scripts/dev-latency-ladder.mjs
//   SAMPLES=8 MODELS=smolvlm2-256m,smolvlm2-500m node scripts/dev-latency-ladder.mjs

import { percentile } from "../lib/stats.js";
import { BROWSER_MODELS } from "../lib/browser-models.js";

const CDP = process.env.CDP_BASE || "http://127.0.0.1:9222";
const APP = process.env.APP_URL || "http://localhost:3000/";
const WANTED = (process.env.MODELS || Object.keys(BROWSER_MODELS).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SAMPLES = Number(process.env.SAMPLES || 5);
// Per-model ceiling: the WASM-fallback rows need minutes per scan.
const MODEL_BUDGET_MS = Number(process.env.MODEL_BUDGET_MS || 12 * 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageTarget() {
  const list = await (await fetch(`${CDP}/json`)).json();
  const pages = list.filter((x) => x.type === "page");
  const t =
    pages.find((x) => x.url.startsWith(APP.replace(/\/$/, ""))) ||
    // Android kills a renderer under memory pressure — which a WASM-fallback
    // row does on every scan — and Chrome keeps the tab, its title, and its
    // debugger socket while blanking the URL. Refusing to use that tab turned
    // a recoverable kill into "no Aura tab" for every row of a run.
    pages.find((x) => (x.title || "").includes("Aura"));
  if (!t) throw new Error(`no Aura tab at ${APP} — open it on the phone (is CDP forwarded?)`);
  if (!t.url.startsWith(APP.replace(/\/$/, ""))) {
    process.stderr.write(`  (reusing Aura tab ${t.id} with blank url — reviving it)\n`);
  }
  return t;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    const events = [];
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && waiting.has(d.id)) {
        const { ok, fail } = waiting.get(d.id);
        waiting.delete(d.id);
        d.error ? fail(new Error(d.error.message)) : ok(d.result);
      } else if (d.method) events.push(d);
    };
    ws.onerror = () => reject(new Error(`CDP websocket error: ${url}`));
    ws.onopen = () =>
      resolve({
        ws,
        events,
        send(method, params = {}, ms = 120_000) {
          const mid = ++id;
          return new Promise((ok, fail) => {
            waiting.set(mid, { ok, fail });
            setTimeout(() => {
              if (waiting.delete(mid)) fail(new Error(`${method} timed out`));
            }, ms);
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        eval(js, { awaitPromise = false } = {}) {
          return this.send("Runtime.evaluate", {
            expression: js,
            returnByValue: true,
            awaitPromise,
          }).then((r) => {
            if (r.exceptionDetails)
              throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result?.value;
          });
        },
        // The app reloads itself when the model changes, which can destroy the
        // execution context while an evaluate is in flight — Chrome then never
        // answers that command. One unanswered call used to abort the whole
        // model row, which is how a 4.6-second model got reported as "no
        // samples". Retry, and never let a probe failure kill the measurement.
        async tryEval(js, tries = 3) {
          for (let i = 0; i < tries; i++) {
            try {
              return await this.eval(js);
            } catch (e) {
              this.lastError = String(e.message).slice(0, 120);
              await sleep(4_000);
            }
          }
          return null;
        },
      });
  });
}

// Wraps Worker so every scan/result pair is timed in the page. Patched before
// any app code runs, because the app builds its worker inside useMonitor.
const HOOK = `(() => {
  if (window.__latPatched) return;
  window.__latPatched = true;
  window.__lat = [];
  const pending = new Map();
  const Native = window.Worker;
  class Timed extends Native {
    constructor(url, opts) {
      super(url, opts);
      const self = this;
      const post = this.postMessage.bind(this);
      this.postMessage = (msg, ...rest) => {
        if (msg && msg.type === 'scan') {
          pending.set(msg.id, { t0: Date.now(), maxNewTokens: msg.maxNewTokens ?? null });
        }
        return post(msg, ...rest);
      };
      const record = (ev) => {
        if (!d || d.type !== 'result' || !pending.has(d.id)) return;
        const p = pending.get(d.id);
        pending.delete(d.id);
        window.__lat.push({
          at: new Date().toLocaleTimeString(),
          latencyMs: d.latencyMs ?? null,
          wallMs: Date.now() - p.t0,
          tokens: d.usage ? d.usage.completion_tokens : null,
          promptTokens: d.usage ? d.usage.prompt_tokens : null,
          maxNewTokens: p.maxNewTokens,
          // Confidence the worker derived from its own logits, so the table
          // shows whether a verdict was measured or defaulted to 100.
          conf: d.logits && d.logits.firstTokenProb != null ? Math.round(100 * d.logits.firstTokenProb) : null,
          verdictProb: d.logits && d.logits.verdictProb != null ? Math.round(100 * d.logits.verdictProb) : null,
        });
      };
      const add = this.addEventListener.bind(this);
      this.addEventListener = (type, fn, o) =>
        type === 'message' ? add(type, (ev) => { record(ev); return fn && fn(ev); }, o) : add(type, fn, o);
      Object.defineProperty(this, 'onmessage', {
        configurable: true,
        get() { return null; },
        set(fn) { add('message', (ev) => { record(ev); return fn && fn(ev); }); },
      });
      void self;
    }
  }
  window.Worker = Timed;
})()`;

async function armTab(client) {
  // The ARM control is an ion-button whose clickable surface is in shadow DOM.
  const v = await client.tryEval(`(() => {
    const b = document.getElementById('toggle');
    if (!b) return 'no-toggle';
    const label = (b.textContent || '').trim().toLowerCase();
    if (label.includes('disarm')) return 'already-armed';
    (b.shadowRoot && b.shadowRoot.querySelector('button') || b).click();
    return 'armed';
  })()`);
  return v || "no-toggle";
}

async function runModel(key) {
  const target = await pageTarget();
  const client = await connect(target.webSocketDebuggerUrl);
  const quiet = (m, p = {}, ms = 45_000) => client.send(m, p, ms).catch(() => {});
  await quiet("Page.enable");
  await quiet("Runtime.enable");
  await quiet("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  await quiet("Page.navigate", { url: APP });
  await sleep(12_000);
  await client.tryEval(`localStorage.setItem('aura.browserModel', ${JSON.stringify(JSON.stringify(key))})`);
  await quiet("Page.navigate", { url: APP });
  await sleep(12_000);
  let armed = "no-toggle";
  for (let i = 0; i < 8 && armed === "no-toggle"; i++) {
    armed = await armTab(client);
    if (armed === "no-toggle") await sleep(5_000);
  }

  const deadline = Date.now() + MODEL_BUDGET_MS;
  let rows = [];
  let ep = null;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const seen = JSON.parse((await client.tryEval(`JSON.stringify(window.__lat || [])`)) || "[]");
    // The Settings STATUS line reports the granted device, which is the
    // execution-provider column this table needs: a WASM fallback stays
    // invisible in latency numbers until they are already minutes long.
    const seenEp = await client.tryEval(
      `(() => { const t = [...document.querySelectorAll('p,div,span,small')].map(e => e.textContent || '');
        const hit = t.find(x => /WEBGPU|WASM|CUDA|buffers/i.test(x)); return hit ? hit.replace(/\\s+/g,' ').slice(0, 90) : null; })()`,
    );
    if (seenEp) ep = seenEp;
    if (seen.length >= SAMPLES) {
      rows = seen;
      break;
    }
    // Recover from a tab that lost its camera or its arm between models.
    if (seen.length === 0 && Date.now() > deadline - MODEL_BUDGET_MS / 2) await armTab(client);
  }
  await quiet("Page.reload", {}, 10_000);
  client.ws.close();
  return { key, armed, ep, rows, err: client.lastError || null };
}

function summarise({ key, armed, ep, rows, err }) {
  const row = BROWSER_MODELS[key];
  const detect = rows.filter(
    (r) => row && r.maxNewTokens === (row.promptProfile === "json" ? 160 : 48),
  );
  const picked = detect.length >= 3 ? detect : rows;
  const use = picked.map((r) => r.latencyMs).filter((n) => Number.isFinite(n));
  // Median logit-derived confidence. A column of 100s means the model is
  // still asserting certainty; a spread means the slider has signal to act on.
  const confs = picked.map((r) => r.conf).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!use.length)
    return { key, label: row?.label || key, n: 0, armed, ep, note: err ? `no samples (${err})` : "no samples" };
  const sorted = [...use].sort((a, b) => a - b);
  return {
    key,
    label: row?.label || key,
    n: use.length,
    p50: +(percentile(sorted, 50) / 1000).toFixed(1),
    p90: +(percentile(sorted, 90) / 1000).toFixed(1),
    max: +(sorted.at(-1) / 1000).toFixed(1),
    tok: +(rows.reduce((s, r) => s + (r.tokens || 0), 0) / rows.length).toFixed(1),
    conf: confs.length ? Math.round(percentile(confs, 50)) : null,
    role: detect.length >= 3 ? "detect-only" : "all-calls",
    ep,
    armed,
    note: err || null,
  };
}

const out = [];
for (const key of WANTED) {
  process.stderr.write(`\n--- ${key} (need ${SAMPLES} samples)\n`);
  try {
    out.push(summarise(await runModel(key)));
  } catch (err) {
    out.push({ key, label: BROWSER_MODELS[key]?.label || key, n: 0, note: String(err.message).slice(0, 90) });
  }
  process.stderr.write(JSON.stringify(out.at(-1)) + "\n");
}

console.log("\nmodel".padEnd(16), "n".padEnd(3), "p50s".padEnd(7), "p90s".padEnd(7), "maxs".padEnd(7), "tok".padEnd(6), "conf".padEnd(5), "role".padEnd(11), "device / status".padEnd(30), "note");
for (const r of out) {
  console.log(
    String(r.label).padEnd(16),
    String(r.n).padEnd(3),
    String(r.p50 ?? "-").padEnd(7),
    String(r.p90 ?? "-").padEnd(7),
    String(r.max ?? "-").padEnd(7),
    String(r.tok ?? "-").padEnd(6),
    String(r.conf ?? "-").padEnd(5),
    String(r.role ?? "-").padEnd(11),
    String(r.ep || r.armed || "-").padEnd(30),
    r.note || "",
  );
}
