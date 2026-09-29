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
// Tab ids as NavRail names them; the redesign renames these, so the list is
// the one place to update.
const SCREENS = ["monitor", "mission", "history", "settings", "optimize", "eval"];

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
  if (!existsSync(path.join(PUBLIC, "assets", "app.js"))) throw new Error("run `npm run build` first");
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), "aura-screens-"));
  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chrome, port } = launchChrome({ profile: path.join(work, "profile"), video: fakeVideo(work) });

  const failures = [];
  try {
    const cdp = await cdpConnect(port);
    const { page, evaluate } = await openPage(cdp);
    await page("Page.enable");
    await page("Runtime.enable");
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
      await page("Page.navigate", { url: origin + "/index.html" });
      await sleep(2500);
      for (const screen of SCREENS) {
        // OPTIMIZE is hidden on engines that can't run it; skip what isn't there.
        const present = await evaluate(
          `(() => { const b = document.querySelector('ion-tab-button[tab="${screen}"]'); if (!b) return false; b.click(); return true; })()`,
        );
        if (!present) { console.log(`${layout.name}/${screen}: no tab, skipped`); continue; }
        await sleep(900);
        const { data } = await page("Page.captureScreenshot", { format: "png" });
        writeFileSync(path.join(OUT, `${layout.name}-${screen}.png`), Buffer.from(data, "base64"));
        if (screen === "monitor") {
          const box = await evaluate(
            `(() => { const b = document.querySelector('#toggle'); if (!b) return null;
               const r = b.getBoundingClientRect();
               return { top: r.top, bottom: r.bottom, vh: window.innerHeight }; })()`,
          );
          const ok = box && box.top >= 0 && box.bottom <= box.vh;
          console.log(`${layout.name}/monitor: ARM ${box ? (ok ? "on screen" : `OFF SCREEN (bottom ${Math.round(box.bottom)} > ${box.vh})`) : "not found"}`);
          if (!ok) failures.push(`${layout.name}: ARM button not visible without scrolling`);
        }
      }
    }
    cdp.close();
  } finally {
    chrome.kill();
    server.close();
  }
  console.log(`screenshots → ${path.relative(ROOT, OUT)}/`);
  if (failures.length) {
    console.log(`\n${failures.length} layout check(s) failed:\n  ${failures.join("\n  ")}`);
    if (STRICT) process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
