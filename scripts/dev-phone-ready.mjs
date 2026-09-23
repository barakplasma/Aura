#!/usr/bin/env node
// Dev instrument: bring the reference phone to a state where a browser-model
// measurement can actually run, or say precisely why it cannot.
//
// Why this exists: every long latency run this session was lost to the same
// three failures, each of which looked like a model bug in the harness output:
//
//   1. `adb reverse`/`forward` die with the wireless transport, so the page
//      loads a stale bundle or CDP answers nothing.
//   2. A service worker left in Chrome's cache serves yesterday's chunk, and
//      the app then runs code that is not on disk.
//   3. The keyguard is up. Android's camera service then logs
//      `REJECT device 0 client for package com.android.chrome ... cannot open
//      camera "0" from background`, and the app shows "Camera unavailable:
//      Could not start video source" while the model looks broken. Nothing in
//      the app can fix that; it needs a PIN typed by a person.
//
// Usage:
//   ANDROID_SERIAL=192.168.1.150:44587 node scripts/dev-phone-ready.mjs
//   CLEAR_SW=1 ANDROID_SERIAL=... node scripts/dev-phone-ready.mjs   # also drop shell caches
//
// Exits 0 only when the app tab is visible and the camera is grantable.
"use strict";

import { execFileSync } from "node:child_process";

const ADB = process.env.ADB || `${process.env.HOME}/bin/adb`;
const SERIAL = process.env.ANDROID_SERIAL || "";
const APP = process.env.APP_URL || "http://localhost:3000/";
const CDP = process.env.CDP_BASE || "http://127.0.0.1:9222";
const PKG = process.env.CHROME_PKG || "com.android.chrome";
const CLEAR_SW = process.env.CLEAR_SW === "1";

const problems = [];
const notes = [];

function adb(...args) {
  return execFileSync(ADB, SERIAL ? ["-s", SERIAL, ...args] : args, {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// --- 1. transport -----------------------------------------------------------
section("transport");
let state = "";
try {
  state = adb("get-state").trim();
} catch (e) {
  problems.push(
    `adb is not talking to ${SERIAL || "the device"} (${String(e.message).split("\n")[0]}). ` +
      `Run: adb connect <phone-ip:port> && adb devices`,
  );
}
console.log(`adb get-state: ${state || "unreachable"}`);

if (!problems.length) {
  // Ports, not metaphors: 3000 serves the app to the phone, 8099 is the
  // webhook sink, 9222 is CDP into Chrome.
  const ports = [
    ["forward", "tcp:9222", "localabstract:chrome_devtools_remote"],
    ["reverse", "tcp:3000", "tcp:3000"],
    ["reverse", "tcp:8099", "tcp:8099"],
  ];
  for (const [kind, a, b] of ports) {
    try {
      adb(kind, a, b);
      console.log(`${kind} ${a} -> ${b}: ok`);
    } catch (e) {
      problems.push(`${kind} ${a} -> ${b} failed: ${String(e.message).split("\n")[0]}`);
    }
  }
  adb("shell", "svc", "power", "stayon", "true");
  console.log("svc power stayon true: ok (screen stays awake while charging)");
}

// --- 2. screen and keyguard -------------------------------------------------
section("screen");
if (!problems.length) {
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "cmd", "statusbar", "collapse");
  await new Promise((r) => setTimeout(r, 1_200));
  const win = adb("shell", "dumpsys", "window");
  const keyguard = /isKeyguardShowing=true/.test(win);
  const focus = (win.match(/mCurrentFocus=Window\{[^}]*\}/g) || []).join(" | ") || "unknown";
  const screen = (win.match(/screenState=[A-Z_]+/g) || ["unknown"])[0];
  console.log(`screen: ${screen}`);
  console.log(`focus:  ${focus}`);
  if (keyguard) {
    problems.push(
      "the keyguard is showing. Android refuses the camera for a backgrounded " +
        "Chrome (`cannot open camera \"0\" from background`), so no scan can run " +
        "until the phone is unlocked by hand — the bouncer on this device wants "
        + "the PIN, which no adb command can type.",
    );
  }
}

// --- 3. app in the foreground ----------------------------------------------
section("chrome");
if (!problems.length) {
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", APP, PKG);
  await new Promise((r) => setTimeout(r, 6_000));
  const win = adb("shell", "dumpsys", "window");
  const focus = (win.match(/mCurrentFocus=Window\{[^}]*\}/g) || []).join(" | ");
  console.log(`focus after launch: ${focus || "unknown"}`);
  if (!/chrome/i.test(focus || ""))
    notes.push(`Chrome does not hold focus (${focus}); the camera may still be refused`);
}

// --- 4. the app tab over CDP ------------------------------------------------
section("app tab");
let page = null;
if (!problems.length) {
  let list = [];
  try {
    const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(8_000) });
    list = await res.json();
  } catch (e) {
    problems.push(`CDP ${CDP}/json/list failed: ${e.message} — is Chrome running on the phone?`);
  }
  const pages = list.filter((t) => t.type === "page" && (t.url || "").includes("localhost:3000"));
  console.log(`app tabs: ${pages.length}`);
  if (!pages.length) {
    problems.push(`no tab open at ${APP} — open it in Chrome on the phone`);
  } else if (pages.length > 1) {
    problems.push(
      `${pages.length} app tabs are open: two workers will fight over one camera and ` +
        "every latency number will be meaningless. Close all but one.",
    );
  } else {
    page = pages[0];
  }
}

if (page) {
  // Node's built-in WebSocket, as in the other dev harnesses: `ws` is not a
  // dependency of this project, only a transitive one.
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, ms = 25_000) =>
    new Promise((ok, fail) => {
      const i = ++id;
      const tm = setTimeout(() => pending.delete(i) && fail(new Error(`${method} timed out`)), ms);
      pending.set(i, { ok, fail, tm });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { ok, fail, tm } = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(tm);
      m.error ? fail(new Error(JSON.stringify(m.error))) : ok(m.result);
    }
  };
  await new Promise((r) => (ws.onopen = r));
  await send("Runtime.enable");
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      return `EXC ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`;
    return r.result?.value;
  };

  if (CLEAR_SW) {
    console.log(
      "service workers cleared:",
      await ev(
        `(async () => { const rs = await navigator.serviceWorker.getRegistrations(); ` +
          `for (const r of rs) await r.unregister(); ` +
          `const ks = (await caches.keys()).filter(k => /aura|shell|workbox/i.test(k)); ` +
          `for (const k of ks) await caches.delete(k); ` +
          `return {unregistered: rs.length, cachesDropped: ks}; })()`,
      ),
    );
    await send("Page.enable");
    await send("Page.navigate", { url: APP });
    await new Promise((r) => setTimeout(r, 8_000));
  }

  console.log(
    "page:",
    await ev(
      `JSON.stringify({visible: document.visibilityState, ` +
        `toggle: (document.getElementById('toggle')?.textContent || 'missing').trim().slice(0,24), ` +
        `mission: JSON.parse(localStorage.getItem('aura.mission') || 'null'), ` +
        `model: localStorage.getItem('aura.browserModel'), ` +
        `runtime: localStorage.getItem('aura.runtime')})`,
    ),
  );
  console.log(
    "status:",
    String(await ev(`document.body.innerText.replace(/\\s+/g," ").slice(0,140)`)).trim(),
  );
  const visible = await ev(`document.visibilityState`);
  if (visible !== "visible")
    problems.push(
      `the app tab is ${visible}: a hidden tab stops its camera, so arm the monitor with the phone ` +
        "showing the Monitor screen",
    );
  ws.close();
}

section("verdict");
for (const n of notes) console.log(`note: ${n}`);
if (problems.length) {
  for (const p of problems) console.log(`BLOCKED: ${p}`);
  process.exit(1);
}
console.log("GO: tunnels up, screen awake and unlocked, one visible app tab.");
console.log("next: ANDROID_SERIAL=$ANDROID_SERIAL node scripts/dev-verdict-probe.mjs");
