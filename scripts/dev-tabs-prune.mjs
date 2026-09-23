#!/usr/bin/env node
// Dev instrument: leave exactly one app tab open in the phone's Chrome.
//
// Why: earlier runs left a tab behind at every `am start` and every model
// switch, and a latency run against several app tabs is not just noisy — it is
// meaningless. Two workers take the camera in turn, so the scan that "won"
// alternates and the samples are a mixture of two processes competing for one
// sensor. `scripts/dev-phone-ready.mjs` refuses to proceed past the duplicate,
// and this closes them.
//
// Scoped on purpose. An earlier session of this project closed 141 tabs in one
// sweep and turned a measurement run into a hunt for the user's reading list,
// so this script only ever touches targets whose URL contains MATCH (default
// `localhost:3000`), prints every tab it sees, and keeps the visible one.
//
//   ANDROID_SERIAL=192.168.1.150:44587 node scripts/dev-tabs-prune.mjs
//   MATCH=localhost:3000 node scripts/dev-tabs-prune.mjs
"use strict";

const CDP = process.env.CDP_BASE || "http://127.0.0.1:9222";
const MATCH = process.env.MATCH || "localhost:3000";

const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(8_000) });
const all = await res.json();
const pages = all.filter((t) => t.type === "page");
const mine = pages.filter((t) => (t.url || "").includes(MATCH));
const others = pages.filter((t) => !(t.url || "").includes(MATCH));

console.log(`${pages.length} page tab(s); ${mine.length} match "${MATCH}"; ${others.length} untouched`);
for (const t of mine) console.log(`  candidate ${t.id}  ${t.url}  | ${(t.title || "").slice(0, 40)}`);
if (others.length)
  console.log(
    `  left alone: ${others
      .slice(0, 6)
      .map((t) => new URL(t.url).host)
      .join(", ")}${others.length > 6 ? ` +${others.length - 6} more` : ""}`,
  );

if (mine.length <= 1) {
  console.log("nothing to prune");
  process.exit(0);
}

// Keep the tab the user is actually looking at; a hidden duplicate is the one
// to drop. Falls back to the first candidate if none reports `visible`.
async function visibility(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  const out = await new Promise((r) => {
    const tm = setTimeout(() => r(null), 6_000);
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === 1) {
        clearTimeout(tm);
        r(m.result?.result?.value ?? null);
      }
    };
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression: "document.visibilityState", returnByValue: true },
      }),
    );
  });
  ws.close();
  return out;
}

const states = [];
for (const t of mine) states.push({ id: t.id, state: (await visibility(t)) || "unknown" });
console.log("visibility:", states.map((s) => `${s.id}=${s.state}`).join(" "));

const keep = states.find((s) => s.state === "visible")?.id || states[0].id;
for (const t of mine) {
  if (t.id === keep) continue;
  const r = await fetch(`${CDP}/json/close/${t.id}`, { signal: AbortSignal.timeout(8_000) });
  console.log(`closed ${t.id}: ${await r.text()}`);
}
console.log(`kept ${keep}`);
