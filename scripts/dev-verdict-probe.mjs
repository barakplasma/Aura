#!/usr/bin/env node
// Content-sensitivity A/B on one live camera frame.
//
// The question this exists to answer is narrow and has been dodged for too
// long: does the detector actually look at the pixels, or does it say YES
// because saying YES is what a small decoder-only model tends to do? The only
// honest instrument is the same frame scored against two missions — one that is
// in view and one that is not — with the model's own words printed. Alert
// counts, "ALERT" banners and parsed confidences all failed to settle it,
// because a degenerate `YES` produces an alert and a fabricated 100% just the
// same as a real sighting.
//
// It patches Worker on the page so the worker's raw `result.text` and
// `logits` (P(YES) from the first generated token) are captured unmodified,
// then re-arms once per mission.
//
//   node scripts/dev-verdict-probe.mjs
//   MISSIONS="a stack of books|a red bicycle" SAMPLES=3 node scripts/dev-verdict-probe.mjs
//
// Requires: `npm run dev`, `adb reverse tcp:3000 tcp:3000`, the phone unlocked
// with camera permission already granted, and exactly one app tab open.
"use strict";

const CDP = process.env.CDP_BASE || "http://127.0.0.1:9222";
const APP = process.env.APP_URL || "http://localhost:3000/";
const SAMPLES = Number(process.env.SAMPLES || 3);
const MISSIONS = (process.env.MISSIONS ||
  "a stack of books|a bicycle with a front basket")
  .split("|")
  .map((s) => s.trim())
  .filter(Boolean);
// A scan on WASM can take minutes; this is a per-mission ceiling, not a target.
const MISSION_BUDGET_MS = Number(process.env.MISSION_BUDGET_MS || 10 * 60_000);

// Module scope so the top-level catch can still close the devtools socket when
// main() dies after connecting.
let client = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`${CDP}/json`);
  if (!res.ok) throw new Error(`CDP ${CDP}/json -> HTTP ${res.status}`);
  return res.json();
}

async function pageTarget() {
  const list = await targets();
  const pages = list.filter((t) => t.type === "page");
  const app = pages.filter(
    (t) => (t.url || "").includes("localhost:3000") || (t.title || "").includes("Aura"),
  );
  if (!app.length) throw new Error(`no Aura tab at ${APP} — open it on the phone`);
  if (app.length > 1) {
    throw new Error(
      `${app.length} Aura tabs open — close all but one, or two cameras and two ` +
        `workers will make every number meaningless`,
    );
  }
  return app[0];
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    // The timer lives on the pending entry. Keeping it in a parallel Set and
    // looking it up with `.get()` was a bug — Sets have no `get`, so the first
    // reply that arrived killed the process with "timers.get is not a function".
    const send = (method, params = {}, timeoutMs = 15_000) =>
      new Promise((ok, fail) => {
        const i = ++id;
        const t = setTimeout(() => {
          if (pending.delete(i)) fail(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(i, { ok, fail, t });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { ok, fail, t } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(t);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        console.log(`  [page-exception] ${d?.text} ${d?.exception?.description || ""}`);
      }
    };
    ws.onerror = (e) => reject(new Error(`websocket error: ${e.message || "unknown"}`));
    ws.onclose = () => {
      for (const { fail, t } of pending.values()) {
        clearTimeout(t);
        fail(new Error("devtools socket closed"));
      }
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send,
        close: () => ws.close(),
        // The app self-reloads on a service-worker update, which drops the
        // socket mid-evaluate. One reconnect is enough in practice; more just
        // hides a device that is genuinely wedged.
        async tryEval(js, tries = 3) {
          for (let i = 1; i <= tries; i++) {
            try {
              const r = await send(
                "Runtime.evaluate",
                { expression: js, returnByValue: true, awaitPromise: true },
                30_000,
              );
              if (r?.exceptionDetails) {
                console.log(`  [eval-exception] ${r.exceptionDetails.text}`);
                return undefined;
              }
              return r?.result?.value;
            } catch (e) {
              console.log(`  [eval-try ${i}/${tries}] ${e.message}`);
              if (i < tries) await sleep(2_000);
            }
          }
          return undefined;
        },
      });
  });
}

// Captured in the page before the app's worker exists: the app builds it inside
// useMonitor, so patching any earlier than document_start loses the race.
// Registrations from earlier runs stay installed in the tab, so records carry
// a version and the collector only accepts its own.
const HOOK_V = 1;
const HOOK = `(() => {
  if (window.__vV === ${HOOK_V}) return;
  window.__vV = ${HOOK_V};
  window.__v = [];
  const Native = window.Worker;
  class Spied extends Native {
    constructor(url, opts) {
      super(url, opts);
      this.addEventListener('message', (ev) => {
        const m = ev.data;
        if (!m || typeof m !== 'object') return;
        if (m.type === 'ready') {
          window.__v.push({ v: ${HOOK_V}, kind: 'ready', device: m.device, yesNoIds: m.yesNoIds ?? null, runtime: m.runtime || null });
        } else if (m.type === 'result') {
          window.__v.push({
            v: ${HOOK_V},
            kind: 'scan',
            ms: m.latencyMs ?? null,
            t: Math.round(performance.now()),
            tokens: m.usage ? m.usage.completion_tokens ?? null : null,
            truncated: !!m.truncated,
            yesNoIds: m.yesNoIds ?? null,
            firstTokenProb: m.logits ? m.logits.firstTokenProb : null,
            yesProb: m.logits ? m.logits.yesProb ?? null : null,
            text: String(m.text ?? '').replace(/\\s+/g, ' ').trim().slice(0, 320),
          });
        } else if (m.type === 'error') {
          window.__v.push({ v: ${HOOK_V}, kind: 'error', message: String(m.message || '').slice(0, 200) });
        }
      });
    }
  }
  window.Worker = Spied;
})()`;

function yesNo(text) {
  // Same anchor the app uses: a verdict token followed by a number if there is
  // one, else the last verdict in the text. Kept deliberately independent here
  // so the harness can disagree with the product.
  const m = [...String(text || "").matchAll(/\b(yes|no)\b/gi)];
  if (!m.length) return null;
  const numbered = m.filter((x) => /^\W*\d/.test(String(text).slice((x.index || 0) + x[0].length)));
  const pick = (numbered.length ? numbered : m).at(-1);
  return String(pick[1]).toUpperCase();
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

async function main() {
  let target;
  try {
    target = await pageTarget();
  } catch (e) {
    console.log(`cannot start: ${e.message}`);
    process.exit(1);
  }
  console.log(`page: ${target.targetId} ${target.url}`);
  client = await connect(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
  // No reload per mission. A 500M weight load plus WebGPU init costs 6-9
  // minutes on this phone and starved the first run of samples. The monitor
  // re-reads the mission before every scan, so the A/B can swap it on a live
  // worker and pay that tax once.
  await client.send("Page.navigate", { url: APP });
  await sleep(9_000);

  const goTab = async (label) => {
    const ok = await client.tryEval(
      `(() => { const b = [...document.querySelectorAll('ion-tab-button')]
          .find(x => new RegExp(${JSON.stringify(label)}, 'i').test(x.textContent || ''));
        if (!b) return 'TAB MISSING'; b.click(); return 'ok'; })()`,
    );
    if (String(ok) !== "ok") throw new Error(`cannot open the ${label} tab: ${ok}`);
    await sleep(2_500);
  };

  // The mission field is an Ionic custom element on the Missions tab: its real
  // textarea sits in shadow DOM, React state updates only from `ionInput`
  // (which the inner textarea emits for a composed `input` event), and the
  // field is not in the document at all while another tab is mounted. An
  // earlier revision looked for `#mission` and reported "MISSING".
  const setMission = async (mission) => {
    await goTab("mission");
    const got = await client.tryEval(
      `(() => { const host = document.querySelector('ion-textarea[label="Watch for"]') || document.querySelector('ion-textarea');
        if (!host) return 'FIELD MISSING';
        const ta = host.shadowRoot?.querySelector('textarea') || host.querySelector('textarea') || host;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ${JSON.stringify(mission)});
        ta.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        return String(ta.value); })()`,
    );
    if (String(got) !== mission) throw new Error(`mission did not stick (read back: ${got})`);
    await goTab("home");
  };

  // Arm idempotently by reading the button: the app restores `armed` from
  // localStorage, so a blind click can disarm a running monitor and spend the
  // whole budget collecting nothing. Re-checked per mission because a tab
  // switch or a failed scan can leave the monitor stopped mid-run.
  const toggleText = `String((document.getElementById('toggle')?.textContent || 'missing').trim())`;

  // Cursor, not a rescan: `window.__v` is append-only, so re-reading it from 0
  // each poll counted every scan again — the first run reported two identical
  // samples and called them two observations.
  let cursor = 0;
  const rows = [];
  for (const mission of MISSIONS) {
    console.log(`\n=== mission: "${mission}" ===`);
    await setMission(mission);
    if (String((await client.tryEval(toggleText)) || "").startsWith("Arm")) {
      await client.tryEval(`document.getElementById('toggle').click()`);
      await sleep(6_000); // let the worker come up before the first scan
    }
    const scans = [];
    const deadline = Date.now() + MISSION_BUDGET_MS;
    let lastLog = 0;
    while (Date.now() < deadline && scans.length < SAMPLES) {
      await sleep(5_000);
      let all = [];
      try {
        const v = await client.tryEval(`JSON.stringify((window.__v || []).slice(${cursor}))`);
        all = JSON.parse(v || "[]");
      } catch {
        continue;
      }
      cursor += all.length;
      for (const m of all) {
        if (m.kind === "ready" && m.runtime) {
          console.log(
            `  worker ready: device=${m.device} yes/no ids=${JSON.stringify(m.yesNoIds)} ` +
              `isolated=${m.runtime.isolated} threads=${m.runtime.numThreads} proxy=${m.runtime.proxy}`,
          );
        } else if (m.kind === "error") {
          console.log(`  worker error: ${m.message}`);
        } else if (m.kind === "scan") {
          scans.push(m);
          console.log(
            `  [${scans.length}] ${m.ms}ms tok=${m.tokens ?? "-"}${m.truncated ? " truncated" : ""} ` +
              `logitYES=${m.firstTokenProb ?? "-"} => ${yesNo(m.text) || "?"} | ${m.text.slice(0, 160)}`,
          );
        }
      }
      if (Date.now() - lastLog > 45_000) {
        lastLog = Date.now();
        const st = await client.tryEval(`document.body.innerText.replace(/\\s+/g," ").slice(0,110)`);
        console.log(`  status: ${String(st || "").slice(0, 100)}`);
      }
    }
    const yes = scans.filter((s) => yesNo(s.text) === "YES").length;
    rows.push({
      mission,
      n: scans.length,
      yes,
      no: scans.filter((s) => yesNo(s.text) === "NO").length,
      medMs: median(scans.map((s) => s.ms).filter(Number.isFinite)),
      medTok: median(scans.map((s) => s.tokens).filter(Number.isFinite)),
      medLogitYes: median(scans.map((s) => s.firstTokenProb).filter((x) => Number.isFinite(x))),
      sample: scans[0]?.text?.slice(0, 140) || null,
    });
    console.log(`  => ${yes}/${scans.length} YES, median ${rows.at(-1).medMs}ms`);
  }
  await client.tryEval(
    `(() => { const b = document.getElementById('toggle'); if (b && /^Disarm/i.test(b.textContent)) b.click(); })()`,
  );

  console.log("\n=== verdict table ===");
  console.table(rows);
  const [first, second] = rows;
  if (first?.n && second?.n) {
    const flipped = first.yes > 0 && second.yes < second.n;
    console.log(
      flipped
        ? "VERDICT: content-sensitive — the in-view mission scored YES while the absent one did not."
        : "VERDICT: NOT proven content-sensitive — both missions scored the same.",
    );
  } else {
    console.log("VERDICT: inconclusive — one or more missions produced no samples.");
  }
  client.close();
}

main().catch((e) => {
  console.log(`FAILED: ${e.stack || e}`);
  client?.close();
  process.exit(1);
});
