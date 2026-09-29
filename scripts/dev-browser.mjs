// Shared plumbing for the dev scripts that drive the built app in headless
// Chromium over raw CDP (dev-gate-e2e.mjs, dev-screens.mjs): a static file
// responder for public/, Chromium with a fake camera, and a minimal CDP client.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { settleReply } from "./cdp-request.mjs";

export const CHROME =
  process.env.CHROME || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".svg": "image/svg+xml", ".map": "application/json",
};

/** Answer with a file under `root`; unknown paths get index.html (SPA). */
export function sendStatic(res, root, pathname) {
  let file = path.join(root, decodeURIComponent(pathname));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  return res.end(readFileSync(file));
}

/** Chromium on a random DevTools port, its camera fed from `video` (a y4m). */
export function launchChrome({ profile, video }) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const chrome = spawn(CHROME, [
    "--headless=new", "--no-sandbox", "--disable-gpu-sandbox",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${video}`,
    ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=127.0.0.1;localhost"] : []),
    "about:blank",
  ], { stdio: "ignore" });
  return { chrome, port };
}

export async function cdpConnect(port) {
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
    if (!settleReply(waiting, msg)) for (const fn of listeners) fn(msg);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      waiting.set(mid, { ok: resolve, fail: reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
    });
  return { send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

/** A fresh tab: `page(method, params)` and `evaluate(expression)` on it. */
export async function openPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => cdp.send(method, params, sessionId);
  const evaluate = async (expression) =>
    (await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  return { page, evaluate };
}
