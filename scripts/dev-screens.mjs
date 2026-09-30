#!/usr/bin/env node
// Dev instrument: screenshots of every screen at the three layouts in
// docs/PRD-ux-redesign.md, so a UI change shows its before/after.
//
// Drives the built app (`npm run build` first) in headless Chromium over raw
// CDP, with a fake camera, and writes docs/screens/<layout>-<screen>.png.
// It also measures where the primary action sits: on the Monitor screen the
// ARM button must be inside the viewport at every layout. Today that fails at
// desktop width (the camera card pushes it below the fold) — the script
// reports it and, with STRICT=1, exits non-zero. The redesign's Phase 1
// acceptance is this check going green.
//
// Usage:
//   node scripts/dev-screens.mjs
//   STRICT=1 node scripts/dev-screens.mjs     # fail when ARM is off screen
//   OUT=/some/dir node scripts/dev-screens.mjs
//   BASE_URL=https://barakplasma.github.io/Aura/ OUT=/tmp/live node scripts/dev-screens.mjs
//       # drive a deployed build instead of public/: same layout checks, plus
//       # every asset request must succeed and the service worker must precache
//       # the stylesheets (a sub-path deploy is where asset URLs break)

import http from "node:http";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cdpConnect, launchChrome, openPage, sendStatic, sleep } from "./dev-browser.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const OUT = process.env.OUT || path.join(ROOT, "docs", "screens");
const STRICT = process.env.STRICT === "1";

const LAYOUTS = [
  { name: "phone", width: 412, height: 915, mobile: true },
  { name: "landscape", width: 915, height: 412, mobile: true },
  { name: "desktop", width: 1440, height: 900, mobile: false },
];
// data-nav ids as AppShell names them (docs/PRD-ux-redesign.md): four
// destinations. Lab has no phone tab, so it is reached from Setup there.
const SCREENS = ["watch", "alerts", "setup", "lab"];

function serve() {
  const server = http.createServer((req, res) => sendStatic(res, PUBLIC, new URL(req.url, "http://x").pathname));
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// A flat grey 640x480 y4m, 2 frames: enough for the fake capture device.
function fakeVideo(dir) {
  const W = 640, H = 480;
  const frame = Buffer.concat([
    Buffer.from("FRAME\n"),
    Buffer.alloc(W * H, 110),
    Buffer.alloc((W / 2) * (H / 2), 128),
    Buffer.alloc((W / 2) * (H / 2), 128),
  ]);
  const file = path.join(dir, "scene.y4m");
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F2:1 Ip A1:1 C420jpeg\n`), frame, frame]));
  return file;
}

async function main() {
  if (!process.env.BASE_URL && !existsSync(path.join(PUBLIC, "assets", "app.js"))) throw new Error("run `npm run build` first");
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), "aura-screens-"));
  const BASE = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/?$/, "/") : null;
  const server = BASE ? null : await serve();
  const origin = BASE ? BASE.slice(0, -1) : `http://127.0.0.1:${server.address().port}`;
  const failedRequests = [];
  const { chrome, port } = launchChrome({ profile: path.join(work, "profile"), video: fakeVideo(work) });

  const failures = [];
  try {
    const cdp = await cdpConnect(port);
    const { page, evaluate } = await openPage(cdp);
    await page("Page.enable");
    await page("Runtime.enable");
    // Any uncaught exception in any screen is a failure: the branches a
    // screenshot doesn't reach (an engine's fields, a closed fold) would
    // otherwise only break in someone's hands.
    if (BASE) await page("Network.enable");
    const urls = new Map();
    cdp.on((msg) => {
      if (msg.method === "Network.requestWillBeSent") urls.set(msg.params.requestId, msg.params.request.url);
      if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
        failedRequests.push(`${msg.params.response.status} ${msg.params.response.url}`);
      }
      if (msg.method === "Network.loadingFailed" && !msg.params.canceled) {
        failedRequests.push(`failed (${msg.params.errorText}) ${urls.get(msg.params.requestId) || msg.params.requestId}`);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        failures.push(`uncaught exception: ${(d.exception?.description || d.text || "").split("\n")[0].slice(0, 200)}`);
      }
    });
    // Configured enough that the app doesn't show a first-run state, without
    // touching the network: a local provider URL, no key.
    await page("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem('aura.baseUrl', JSON.stringify('http://127.0.0.1:1/v1'));
               localStorage.setItem('aura.model', JSON.stringify('demo-model'));
               localStorage.setItem('aura.mission', JSON.stringify('a person at the front door'));`,
    });

    for (const layout of LAYOUTS) {
      await page("Emulation.setDeviceMetricsOverride", {
        width: layout.width, height: layout.height, deviceScaleFactor: 1, mobile: layout.mobile,
      });
      await page("Page.navigate", { url: BASE || origin + "/index.html" });
      await sleep(2500);
      for (const screen of SCREENS) {
        // Both navs exist in the DOM; click the one that is on screen (Lab is
        // rail-only, so at phone widths it is reached through Setup's link).
        const present = await evaluate(
          `(() => { const b = [...document.querySelectorAll('[data-nav="${screen}"]')].find((n) => n.offsetParent);
             if (!b) return false; b.click(); return true; })()`,
        );
        let viaSetup = false;
        if (!present && screen === "lab") {
          // No phone tab for Lab: Setup carries a link to it.
          await evaluate(`[...document.querySelectorAll('[data-nav="setup"]')].find((n) => n.offsetParent)?.click()`);
          await sleep(500);
          viaSetup = await evaluate(
            `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith('Lab') && x.offsetParent); if (!b) return false; b.click(); return true; })()`,
          );
        }
        if (!present && !viaSetup) { console.log(`${layout.name}/${screen}: not reachable`); failures.push(`${layout.name}: ${screen} not reachable`); continue; }
        await sleep(900);
        const { data } = await page("Page.captureScreenshot", { format: "png" });
        writeFileSync(path.join(OUT, `${layout.name}-${screen}.png`), Buffer.from(data, "base64"));
        if (screen === "setup") {
          // Setup scrolls inside its own container, so a viewport shot only
          // shows its top. Grow the viewport to the content for a full one.
          await page("Emulation.setDeviceMetricsOverride", { width: layout.width, height: 4200, deviceScaleFactor: 1, mobile: layout.mobile });
          await sleep(400);
          const full = await page("Page.captureScreenshot", { format: "png" });
          writeFileSync(path.join(OUT, `${layout.name}-setup-full.png`), Buffer.from(full.data, "base64"));
          await page("Emulation.setDeviceMetricsOverride", { width: layout.width, height: layout.height, deviceScaleFactor: 1, mobile: layout.mobile });
          await sleep(300);
          if (layout.name === "desktop") {
            // Every engine's fields, and every Advanced fold, rendered.
            const click = (expr) => evaluate(`(() => { const el = ${expr}; if (!el) return false; el.click(); return true; })()`);
            for (const [engine, label] of [["browser", "In-browser"], ["decision", "Decision"], ["provider", "Provider"]]) {
              const ok = await click(`[...document.querySelectorAll('[role=radio]')].find((b) => b.textContent.startsWith('${label}'))`);
              if (!ok) { failures.push(`setup: no ${label} engine card`); continue; }
              await sleep(800);
              if (engine !== "provider") {
                await click(`[...document.querySelectorAll('[data-advanced-item]')].find((b) => b.dataset.advancedItem === 'Object gate')`);
                for (const item of await evaluate(`[...document.querySelectorAll('[data-advanced-item]')].map((b) => b.dataset.advancedItem)`)) {
                  if (item !== "Object gate") await click(`[...document.querySelectorAll('[data-advanced-item]')].find((b) => b.dataset.advancedItem === ${JSON.stringify(item)})`);
                }
                await sleep(500);
                await page("Emulation.setDeviceMetricsOverride", { width: layout.width, height: 5200, deviceScaleFactor: 1, mobile: false });
                await sleep(400);
                const shot = await page("Page.captureScreenshot", { format: "png" });
                writeFileSync(path.join(OUT, `desktop-setup-${engine}.png`), Buffer.from(shot.data, "base64"));
                await page("Emulation.setDeviceMetricsOverride", { width: layout.width, height: layout.height, deviceScaleFactor: 1, mobile: false });
                await sleep(300);
              }
            }
          }
        }
        if (screen === "watch") {
          const box = await evaluate(
            `(() => { const b = document.querySelector('#toggle'); if (!b) return null;
               const r = b.getBoundingClientRect();
               return { top: r.top, bottom: r.bottom, vh: window.innerHeight }; })()`,
          );
          const ok = box && box.top >= 0 && box.bottom <= box.vh;
          console.log(`${layout.name}/watch: ARM ${box ? (ok ? "on screen" : `OFF SCREEN (bottom ${Math.round(box.bottom)} > ${box.vh})`) : "not found"}`);
          if (!ok) failures.push(`${layout.name}: ARM button not visible without scrolling`);
        }
      }
      // Armed, through the demo path (no camera or network needed): the
      // verdict card must show a real scan result and ARM must stay on screen.
      await evaluate(`[...document.querySelectorAll('[data-nav="watch"]')].find((n) => n.offsetParent)?.click()`);
      await sleep(400);
      const started = await evaluate(
        `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Try demo' && x.offsetParent); if (!b) return false; b.click(); return true; })()`,
      );
      if (started) {
        await sleep(7000);
        const { data } = await page("Page.captureScreenshot", { format: "png" });
        writeFileSync(path.join(OUT, `${layout.name}-watch-armed.png`), Buffer.from(data, "base64"));
        const armed = await evaluate(
          `(() => { const v = document.querySelector('[data-verdict]'); const b = document.querySelector('#toggle'); const r = b.getBoundingClientRect();
             return { state: v && v.dataset.verdict, text: v && v.innerText.replace(/\\s+/g, ' ').slice(0, 120), pressed: b.getAttribute('aria-pressed'), onScreen: r.top >= 0 && r.bottom <= window.innerHeight }; })()`,
        );
        console.log(`${layout.name}/watch (armed): ${armed.state} · ${armed.text}`);
        if (armed.pressed !== "true") failures.push(`${layout.name}: demo did not arm`);
        if (!armed.onScreen) failures.push(`${layout.name}: ARM off screen while armed`);
        if (!["watching", "alert", "degraded"].includes(armed.state)) failures.push(`${layout.name}: verdict is "${armed.state}" after a demo scan`);
      } else {
        failures.push(`${layout.name}: no Try demo button on Watch`);
      }
    }
    if (BASE) {
      // What a deployed build has to get right that a local one can hide: the
      // service worker registers under the sub-path and precaches the shell
      // (including the Tailwind sheet), and no asset request failed.
      const sw = await evaluate(`(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        const names = await caches.keys();
        const urls = [];
        for (const n of names) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
        return { scope: reg && reg.scope, state: reg && (reg.active || reg.waiting || reg.installing)?.state, urls };
      })()`);
      console.log(`service worker: scope ${sw.scope} · ${sw.state} · ${sw.urls.length} cached`);
      if (!sw.scope) failures.push("live: no service worker registered");
      for (const need of ["/assets/app.js", "/assets/app.css", "/assets/ui.css"]) {
        if (!sw.urls.some((u) => u.endsWith(need))) failures.push(`live: ${need} is not precached`);
      }
      if (sw.urls.some((u) => u.endsWith("/aura.css"))) failures.push("live: the removed aura.css is still precached");
      for (const f of failedRequests) failures.push(`live request: ${f}`);
      console.log(`network: ${failedRequests.length} failed request(s)`);
    }
    cdp.close();
  } finally {
    chrome.kill();
    server?.close();
  }
  console.log(`screenshots → ${path.relative(ROOT, OUT)}/`);
  if (failures.length) {
    console.log(`\n${failures.length} layout check(s) failed:\n  ${failures.join("\n  ")}`);
    if (STRICT) process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
