#!/usr/bin/env node
// Dev instrument: the object gate, end to end, in a real browser.
//
// Unit tests cover every rule the gate follows (test/gate-session.test.js) and
// the worker's message protocol (test/browser-engine.test.js), but not the
// parts only a browser has: the worker bundle loading YOLO26 through
// Transformers.js, the OffscreenCanvas preprocessing, the ImageBitmap
// transfer, and useMonitor driving all of it off a live <video>. This drives
// the built app in headless Chromium over raw CDP (same approach as
// dev-latency-ladder.mjs), with:
//
//   - a fake camera: a looping video that alternates an empty room with
//     Ultralytics' bus.jpg (a bus and four people), fed through Chromium's
//     fake capture device;
//   - a fake vision model: an OpenAI-compatible endpoint on the app's own
//     origin that answers every scan and counts it — that count is the number
//     the gate exists to shrink;
//   - everything else real: the same YOLO26 bytes the Hub serves, fetched
//     once by Node and handed to the browser through CDP's Fetch domain, so
//     the run doesn't depend on the browser's own route to the Hub (and a
//     second run needs no network at all).
//
// Usage (after `npm run build`):
//   node scripts/dev-gate-e2e.mjs            # gate on, PROVIDER engine
//   GATE=0 node scripts/dev-gate-e2e.mjs     # control run, gate off
//   ENGINE=browser node scripts/dev-gate-e2e.mjs
//       # the in-page VLM (SmolVLM2 256M on WASM) and the detector sharing
//       # one worker — the case the PROVIDER run never exercises
//   SECONDS=120 SCENE_S=20 node scripts/dev-gate-e2e.mjs
//
// Exits non-zero when the gate run fails its own acceptance checks.

import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import WebSocket from "ws";

const ROOT = path.join(import.meta.dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const CHROME =
  process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const GATE = process.env.GATE !== "0";
const ENGINE = process.env.ENGINE === "browser" ? "browser" : "provider";
// The in-page VLM runs on WASM here (headless has no GPU adapter) at many
// seconds a scan, so give it longer.
const RUN_S = Number(process.env.SECONDS || (ENGINE === "browser" ? 240 : 100));
const SCENE_S = Number(process.env.SCENE_S || 20);
const FPS = 2;
const W = 640;
const H = 480;
const BUS_URL = "https://ultralytics.com/images/bus.jpg";
const MIRROR = process.env.MIRROR_DIR || path.join(tmpdir(), "aura-gate-e2e-mirror");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(path.join(tmpdir(), "aura-gate-e2e-"));

// --- the Hub, mirrored on demand ---------------------------------------------

// Every huggingface.co request the browser makes is answered from a local
// cache that Node fills on first use (Node reaches the Hub through the
// session's proxy; this sandbox's browser can't, and a real run shouldn't
// depend on it anyway). The browser is redirected to the app's own origin for
// the bytes rather than handed them over CDP, because a VLM's decoder is far
// bigger than a CDP message should be.
function cachePath(url) {
  const u = new URL(url);
  const key = (u.pathname + (u.search ? "__" + u.search.slice(1) : "")).replace(/[^\w./-]+/g, "_");
  return path.join(MIRROR, key);
}

async function ensureCached(url) {
  const file = cachePath(url);
  const meta = file + ".meta.json";
  if (existsSync(meta)) return JSON.parse(readFileSync(meta, "utf8"));
  const res = await fetch(url, { redirect: "follow" });
  const info = { status: res.status, type: res.headers.get("content-type") || "application/octet-stream" };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0));
  writeFileSync(meta, JSON.stringify(info));
  return info;
}

// --- the fake camera -------------------------------------------------------

// An "empty room": a smooth gradient with a little texture — something a
// detector finds nothing in, but that isn't a flat colour either.
function emptyRoom() {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const t = ((x * 7 + y * 13) % 17) - 8;
      rgb[i] = 150 + (y >> 3) + t;
      rgb[i + 1] = 140 + (x >> 4) + t;
      rgb[i + 2] = 120 + t;
    }
  return rgb;
}

async function busScene() {
  const res = await fetch(BUS_URL);
  if (!res.ok) throw new Error(`fetching ${BUS_URL}: HTTP ${res.status}`);
  const jpg = Buffer.from(await res.arrayBuffer());
  return sharp(jpg).resize(W, H, { fit: "cover" }).removeAlpha().raw().toBuffer();
}

// RGB → one YUV 4:2:0 frame (BT.601 full range, what C420jpeg declares).
function yuv420(rgb) {
  const y = Buffer.alloc(W * H);
  const u = Buffer.alloc((W / 2) * (H / 2));
  const v = Buffer.alloc((W / 2) * (H / 2));
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const p = (j * W + i) * 3;
      y[j * W + i] = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
    }
  for (let j = 0; j < H / 2; j++)
    for (let i = 0; i < W / 2; i++) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const p = ((j * 2 + dy) * W + (i * 2 + dx)) * 3;
        r += rgb[p]; g += rgb[p + 1]; b += rgb[p + 2];
      }
      r /= 4; g /= 4; b /= 4;
      u[j * (W / 2) + i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      v[j * (W / 2) + i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }
  return Buffer.concat([y, u, v]);
}

async function makeVideo() {
  const file = path.join(work, "scene.y4m");
  const [a, b] = [yuv420(emptyRoom()), yuv420(await busScene())];
  const frames = [];
  for (let k = 0; k < SCENE_S * FPS; k++) frames.push(a);
  for (let k = 0; k < SCENE_S * FPS; k++) frames.push(b);
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const tag = Buffer.from("FRAME\n");
  writeFileSync(file, Buffer.concat([header, ...frames.flatMap((f) => [tag, f])]));
  return file;
}

// --- the app, plus a fake vision model on the same origin -------------------

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".svg": "image/svg+xml", ".map": "application/json",
};

const scans = []; // { at, promptChars }

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "fake-vlm" }] }));
    }
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        scans.push({ at: Date.now(), promptChars: body.length });
        const content = JSON.stringify({ triggered: false, confidence: 5, reason: "e2e scene" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "e2e", object: "chat.completion", model: "fake-vlm",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
        }));
      });
      return;
    }
    if (url.pathname === "/__hf") {
      const target = url.searchParams.get("u");
      const file = cachePath(target);
      const info = JSON.parse(readFileSync(file + ".meta.json", "utf8"));
      const bytes = readFileSync(file);
      res.writeHead(info.status, {
        "content-type": info.type,
        // Transformers.js sizes its download buffer (and progress bar) from
        // this; without it every file logs a warning and grows a buffer.
        "content-length": bytes.length,
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "content-length",
      });
      return res.end(bytes);
    }
    let file = path.join(PUBLIC, decodeURIComponent(url.pathname));
    if (!file.startsWith(PUBLIC)) return res.writeHead(403).end();
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(PUBLIC, "index.html");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// --- a minimal CDP client ----------------------------------------------------

async function cdpConnect(port) {
  let info;
  for (let i = 0; i < 50 && !info; i++) {
    try {
      info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    } catch {
      await sleep(200);
    }
  }
  if (!info) throw new Error("Chromium never opened its DevTools port");
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else for (const fn of listeners) fn(msg);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      waiting.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

// --- the run -------------------------------------------------------------------

async function main() {
  console.log(`gate ${GATE ? "ON" : "OFF"} · ${RUN_S}s · scenes of ${SCENE_S}s (empty room ↔ bus.jpg)`);
  const video = await makeVideo();
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const port = 9300 + Math.floor(Math.random() * 500);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu-sandbox",
    `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(work, "profile")}`,
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${video}`,
    ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=127.0.0.1;localhost"] : []),
    "about:blank",
  ], { stdio: "ignore" });

  const cdp = await cdpConnect(port);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => cdp.send(method, params, sessionId);
  const evaluate = async (expression) =>
    (await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;

  const problems = [];
  cdp.on((msg) => {
    if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
      problems.push(`${msg.params.type}: ${text}`.slice(0, 300));
    }
    if (msg.method === "Runtime.exceptionThrown")
      problems.push(`exception: ${msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text}`.slice(0, 300));
  });
  // Answer Hub requests from the mirror, on the page and — crucially — on
  // the dedicated worker that actually loads the detector. Workers only get
  // a CDP session through auto-attach; waitForDebuggerOnStart holds each one
  // until its Fetch interception is in place.
  const hubPattern = [{ urlPattern: "https://huggingface.co/*" }];
  let hubHits = 0;
  cdp.on(async (msg) => {
    if (msg.method === "Target.attachedToTarget") {
      const child = msg.params.sessionId;
      await cdp.send("Fetch.enable", { patterns: hubPattern }, child).catch(() => {});
      await cdp.send("Runtime.enable", {}, child).catch(() => {});
      await cdp.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => {});
    }
    if (msg.method === "Fetch.requestPaused") {
      const url = msg.params.request.url;
      try {
        await ensureCached(url);
        hubHits++;
        await cdp.send("Fetch.fulfillRequest", {
          requestId: msg.params.requestId,
          responseCode: 302,
          responseHeaders: [
            { name: "Location", value: `${origin}/__hf?u=${encodeURIComponent(url)}` },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
        }, msg.sessionId);
      } catch (err) {
        problems.push(`mirror: ${url}: ${err.message}`);
        await cdp.send("Fetch.failRequest", { requestId: msg.params.requestId, errorReason: "Failed" }, msg.sessionId).catch(() => {});
      }
    }
  });
  await page("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  // The in-page VLM makes no HTTP call to count, so count the worker's
  // 'scan' requests instead — the detector's are 'detect', so the two are
  // told apart by type, exactly as the worker itself dispatches them.
  await page("Page.enable"); // addScriptToEvaluateOnNewDocument is inert without it
  await page("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      const post = Worker.prototype.postMessage;
      window.__vlmScans = 0;
      Worker.prototype.postMessage = function (m, t) {
        if (m && m.type === "scan") window.__vlmScans++;
        return post.call(this, m, t);
      };
    })();` });
  await page("Fetch.enable", { patterns: hubPattern });
  await page("Runtime.enable");
  await page("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });

  // Settings are plain JSON in localStorage (useLocalStorage), set on the app's
  // own origin before it boots.
  await page("Page.navigate", { url: `${origin}/v1/models` });
  await sleep(500);
  const settings = {
    "aura.engine": ENGINE, "aura.browserModel": "smolvlm2-256m",
    // lib/settings-migrate.js clears a stored "smolvlm2-256m" once (it used to
    // be the only row, so storing it wasn't a choice) — mark that done, or the
    // app swaps in the WebGPU-only default and the run can't scan headless.
    "aura.browserModelMigrated": true,
    "aura.browserRuntime": "transformers",
    "aura.baseUrl": `${origin}/v1`, "aura.apiKey": "",
    "aura.model": "fake-vlm", "aura.mission": "a person or vehicle", "aura.action": "",
    "aura.scanMode": "interval", "aura.scanEveryValue": 1, "aura.scanEveryUnit": "s",
    "aura.keepScreenOn": false, "aura.speech": false, "aura.haptics": false,
    "aura.objectGate": GATE, "aura.objectModel": "yolo26n-int8",
    "aura.objectGateEveryS": 1, "aura.heartbeatMin": 5,
  };
  await evaluate(`(() => { ${Object.entries(settings)
    .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`)
    .join(" ")} })()`);
  await page("Page.navigate", { url: `${origin}/` });
  for (let i = 0; i < 50 && !(await evaluate(`!!document.querySelector('#toggle')`)); i++) await sleep(200);

  // A real pointer press, not element.click(): #toggle is an Ionic web
  // component, and a synthetic click on its host doesn't reliably reach the
  // React handler the way a user's tap does.
  const box = await evaluate(`(() => {
    const r = document.querySelector('#toggle').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"])
    await page("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  const armedAt = Date.now();
  if (process.env.DEBUG) {
    await sleep(4000);
    console.log("DEBUG page text:\n" + (await evaluate(`document.body.innerText.slice(0, 1200)`)));
  }
  console.log("armed — sampling the gate card every 2 s");

  const samples = [];
  while (Date.now() - armedAt < RUN_S * 1000) {
    await sleep(2000);
    const card = await evaluate(`(() => {
      const c = [...document.querySelectorAll('.notice')].find(n => n.innerText.includes('Object gate'));
      return c ? c.innerText.replace(/\\s+/g, ' ').trim() : '';
    })()`);
    const t = ((Date.now() - armedAt) / 1000).toFixed(0);
    const n = ENGINE === "browser" ? await evaluate(`window.__vlmScans || 0`) : scans.length;
    const status = ENGINE === "browser"
      ? await evaluate(`(document.body.innerText.split('\\n').find(l => /^(Watching|Loading|Error|Monitoring|⚠)/.test(l.trim())) || '').trim().slice(0, 60)`)
      : "";
    samples.push({ t: Number(t), card, scans: n, status });
    console.log(`  t=${t.padStart(3)}s  scans=${String(n).padStart(3)}  ${card || "(no gate card)"}${status ? "  | " + status : ""}`);
  }

  cdp.close();
  chrome.kill("SIGKILL");
  server.close();

  // --- report + acceptance -------------------------------------------------
  const seen = samples.map((s) => s.card).join(" ");
  const vlmCalls = samples.length ? samples.at(-1).scans : 0;
  const sawPeople = /person x[1-9]/.test(seen);
  const sawBus = /bus x1/.test(seen);
  const sawEmpty = /Sees: (nothing yet|—)/.test(seen);
  const noGateTicks = RUN_S; // one per second at objectGateEveryS=1
  console.log(`\ndetector files served from the mirror: ${hubHits}`);
  console.log(`${vlmCalls} VLM calls in ${RUN_S}s` +
    (GATE ? ` (an ungated 1 s cadence would make ~${noGateTicks})` : ""));
  if (problems.length) {
    console.log(`\n${problems.length} console problems (first 8):`);
    for (const p of problems.slice(0, 8)) console.log("  " + p);
  }
  if (!GATE) return;

  const checks = [
    ["the detector ran and saw the people in bus.jpg", sawPeople],
    ["…and the bus", sawBus],
    ["the empty room reads as empty", sawEmpty],
    ["the VLM ran (at least the baseline scan)", vlmCalls >= 1],
    ...(ENGINE === "provider"
      ? [
          ["the gate cut VLM calls by at least 5x", vlmCalls * 5 <= noGateTicks],
          ["it still scanned on every scene change (≥ 1 per change)",
            vlmCalls >= 1 + Math.floor(RUN_S / SCENE_S) - 1],
        ]
      : [
          // On WASM a VLM scan takes longer than a scene lasts, so the
          // cadence here is set by the VLM, not the gate. What this run
          // proves is coexistence: the detector keeps working in the same
          // worker after the VLM has loaded and scanned.
          ["the detector kept working after the VLM loaded",
            samples.some((x) => x.scans >= 1 && /person x[1-9]/.test(x.card))],
        ]),
  ];
  console.log("");
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
    ok &&= pass;
  }
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
