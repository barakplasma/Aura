#!/usr/bin/env node
// Phase 0 of docs/PRD-decision-engine.md: does a CORS relay behave the way
// Aura's DECISION engine needs, and how fast is Replicate through it?
//
// Conformance (no token needed — a fake `r8_` token is forwarded and
// Replicate itself rejects it):
//   node scripts/relay-probe.mjs https://relay.526462738.xyz
//   node scripts/relay-probe.mjs http://127.0.0.1:9876   # `celld dev` in deploy/relay-worker
//   node scripts/relay-probe.mjs 'https://proxy.corsfix.com/?{url}' --hosted
//
// `--hosted` is for a third-party CORS proxy: only the browser-facing
// contract is checked (preflight passes our three headers, Authorization
// reaches Replicate, CORS headers on the answer). Without it the operator
// relay's abuse controls are checked too: 404 without a token / from another
// origin / off the prediction paths, 403 for a model version Aura doesn't pin,
// 413 on a 5 MB body, and Workers AI reachable for Clef's one path only. The
// per-IP rate limit is a zone WAF rule in front of the relay, not the relay's
// own code, so it isn't probed here (Cloudflare rejects a client-set
// CF-Connecting-IP, and one probe host is one IP).
//
// Measurement (spends the caller's own Replicate credit, ~$0.00022 a run):
//   REPLICATE_API_TOKEN=r8_... node scripts/relay-probe.mjs <relay> --measure 100
// runs N Glance predictions on one 640x480 frame, one at a time as the
// monitor does, and prints first-call (cold) time plus warm p50/p95.
//
// The relay argument is the same template the Settings field takes
// (`{path}`, `{url}`, `{url:encoded}`); a bare base URL gets the path appended.
// Exits non-zero when a conformance check fails.

import sharp from "sharp";
import { expandRelayUrl } from "../lib/decision.js";
import { DECISION_MODELS, DEFAULT_DECISION_MODEL } from "../lib/decision-models.js";

const args = process.argv.slice(2);
const relay = args.find((a) => !a.startsWith("--"));
if (!relay) {
  console.error("usage: relay-probe.mjs <relay-url-template> [--hosted] [--origin URL] [--measure N]");
  process.exit(2);
}
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ORIGIN = opt("origin", "https://barakplasma.github.io");
const HOSTED = flag("hosted");
const MEASURE = Number(opt("measure", 0));
const row = DECISION_MODELS[DEFAULT_DECISION_MODEL];
const UPSTREAM = `${row.upstream}/v1/predictions`;
const at = (upstreamUrl) => expandRelayUrl(relay, upstreamUrl);
const FAKE_TOKEN = "r8_relayprobe0000000000000000000000000000";

async function call(url, init = {}) {
  const resp = await fetch(url, { redirect: "manual", ...init, headers: { Origin: ORIGIN, ...(init.headers || {}) } });
  const body = await resp.text().catch(() => "");
  return { status: resp.status, headers: resp.headers, body };
}

// A Cloudflare managed challenge (Bot Fight Mode, a WAF rule, Access)
// answers with HTML a fetch() can never solve — the most likely way a
// correctly configured relay still fails in every browser.
function challenged(r) {
  return r.headers.get("cf-mitigated") === "challenge" || /challenges\.cloudflare\.com/.test(r.body);
}

const results = [];
function check(name, pass, detail = "") {
  results.push(pass);
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const predictBody = (extra = "") =>
  JSON.stringify({ version: row.version, input: { question: "probe", question_type: "yes_no", image_base64: extra } });

async function conformance() {
  console.log(`relay ${relay} · origin ${ORIGIN}${HOSTED ? " · hosted proxy" : ""}`);
  const pre = await call(at(UPSTREAM), {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type,prefer",
    },
  });
  if (challenged(pre)) {
    check("not behind a Cloudflare challenge", false,
      "cf-mitigated: challenge — this host's WAF challenges the probe's country or IP (see deploy/relay-worker/README.md)");
    return;
  }
  const allowHeaders = (pre.headers.get("access-control-allow-headers") || "").toLowerCase();
  check("preflight answered", pre.status >= 200 && pre.status < 300, `HTTP ${pre.status}`);
  check("preflight allows this origin", [ORIGIN, "*"].includes(pre.headers.get("access-control-allow-origin")),
    pre.headers.get("access-control-allow-origin") || "no header");
  check("preflight allows authorization, content-type, prefer",
    ["authorization", "content-type", "prefer"].every((h) => allowHeaders.includes(h) || allowHeaders === "*"),
    allowHeaders || "no header");

  // A fake token must reach Replicate untouched: Replicate answers 401 (its
  // own JSON), and the relay must still attach CORS headers so the browser
  // can read it — that's what turns into "the endpoint rejected your key".
  const fwd = await call(at(UPSTREAM), {
    method: "POST",
    headers: { Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json", Prefer: "wait=1" },
    body: predictBody(),
  });
  // Replicate's own rejection is {"title":"Unauthenticated",...,"status":401};
  // a proxy's own 401/403 (unregistered domain, missing proxy key) is not.
  check("the caller's token reaches Replicate", fwd.status === 401 && /"title"\s*:\s*"Unauthenticated"/.test(fwd.body),
    `HTTP ${fwd.status} ${fwd.body.slice(0, 100).replace(/\s+/g, " ")}`);
  check("the answer carries CORS headers", Boolean(fwd.headers.get("access-control-allow-origin")));

  if (HOSTED) return;

  const noToken = await call(at(UPSTREAM), { method: "POST", headers: { "Content-Type": "application/json" }, body: predictBody() });
  check("no token → 404 (never forwarded)", noToken.status === 404, `HTTP ${noToken.status}`);
  const otherOrigin = await call(at(UPSTREAM), {
    method: "POST",
    headers: { Origin: "https://evil.example", Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json" },
    body: predictBody(),
  });
  check("another origin → 404", otherOrigin.status === 404, `HTTP ${otherOrigin.status}`);
  const offPath = await call(at(`${row.upstream}/v1/account`), { headers: { Authorization: `Bearer ${FAKE_TOKEN}` } });
  check("off the prediction paths → 404", offPath.status === 404, `HTTP ${offPath.status}`);
  // A relay that refuses on Content-Length may close the socket before the
  // upload finishes (celld does); that is a refusal too, not an outage.
  const big = await call(at(UPSTREAM), {
    method: "POST",
    headers: { Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json" },
    body: predictBody("A".repeat(5_000_000)),
  }).catch((err) => ({ status: `closed early (${err.cause?.code || err.message})` }));
  check("5 MB body → 413", big.status === 413 || String(big.status).startsWith("closed early"), `HTTP ${big.status}`);
  const unpinned = await call(at(UPSTREAM), {
    method: "POST",
    headers: { Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ version: "f".repeat(64), input: {} }),
  });
  check("a model version Aura doesn't pin → 403 (never forwarded)", unpinned.status === 403, `HTTP ${unpinned.status}`);

  // Workers AI's Clef: exactly one model path under a 32-hex account, any
  // bearer token (Cloudflare's have no prefix) — so the path is the guard.
  const clef = DECISION_MODELS.clef;
  const account = "0123456789abcdef0123456789abcdef";
  const cfToken = "cfrelayprobe00000000000000000000000000000";
  const clefCall = (url, init = {}) => call(at(url), {
    method: "POST",
    headers: { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" },
    body: "{}",
    ...init,
  });
  const clefUrl = `${clef.upstream}/client/v4/accounts/${account}/ai/run/${clef.workersModel}`;
  const toCf = await clefCall(clefUrl);
  check("Clef: the caller's token reaches Cloudflare", toCf.status !== 404 && Boolean(toCf.headers.get("access-control-allow-origin")),
    `HTTP ${toCf.status} ${toCf.body.slice(0, 80).replace(/\s+/g, " ")}`);
  const otherModel = await clefCall(`${clef.upstream}/client/v4/accounts/${account}/ai/run/@cf/meta/llama-3.1-8b-instruct`);
  check("Clef: another Workers AI model → 404", otherModel.status === 404, `HTTP ${otherModel.status}`);
  const otherApi = await clefCall(`${clef.upstream}/client/v4/accounts/${account}/workers/scripts`, { method: "GET", body: undefined });
  check("Clef: the rest of the Cloudflare API → 404", otherApi.status === 404, `HTTP ${otherApi.status}`);
  const badAccount = await clefCall(`${clef.upstream}/client/v4/accounts/not-an-account/ai/run/${clef.workersModel}`);
  check("Clef: a non-hex account → 404", badAccount.status === 404, `HTTP ${badAccount.status}`);
  const clefNoToken = await clefCall(clefUrl, { headers: { "Content-Type": "application/json" } });
  check("Clef: no token → 404", clefNoToken.status === 404, `HTTP ${clefNoToken.status}`);
}

async function testFrame() {
  // A flat mid-grey 640x480 JPEG: the shape of a real frame, no content.
  const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .jpeg({ quality: 50 })
    .toBuffer();
  return jpeg.toString("base64");
}

async function predictOnce(token, image) {
  const started = performance.now();
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  let r = await call(at(UPSTREAM), {
    method: "POST",
    headers: { ...headers, Prefer: "wait=15" },
    body: JSON.stringify({
      version: row.version,
      input: { question: "Is there a person in the image?", question_type: "yes_no", image_base64: image },
    }),
  });
  let json = JSON.parse(r.body || "{}");
  if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  while (!["succeeded", "failed", "canceled"].includes(json.status)) {
    await new Promise((res) => setTimeout(res, 1000));
    r = await call(at(`${UPSTREAM}/${json.id}`), { headers });
    json = JSON.parse(r.body || "{}");
  }
  if (json.status !== "succeeded") throw new Error(`prediction ${json.status}: ${json.error}`);
  return { totalMs: performance.now() - started, predictMs: (json.metrics?.predict_time || 0) * 1000, answer: json.output?.answer };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function measure(n) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error("--measure needs REPLICATE_API_TOKEN (your own; each run is billed to you).");
  const image = await testFrame();
  console.log(`\nmeasuring ${n} ${row.label} predictions through the relay (one in flight, like the monitor)`);
  const runs = [];
  for (let i = 0; i < n; i++) {
    const r = await predictOnce(token, image);
    runs.push(r);
    if (i === 0) console.log(`  first call ${Math.round(r.totalMs)} ms (predict ${Math.round(r.predictMs)} ms) — includes any cold start`);
  }
  const warm = runs.slice(1);
  if (warm.length) {
    const total = warm.map((r) => r.totalMs);
    const predict = warm.map((r) => r.predictMs);
    console.log(`  warm total   p50 ${Math.round(pct(total, 50))} ms  p95 ${Math.round(pct(total, 95))} ms`);
    console.log(`  warm predict p50 ${Math.round(pct(predict, 50))} ms  p95 ${Math.round(pct(predict, 95))} ms`);
    console.log(`  est. cost ${(runs.reduce((s, r) => s + r.predictMs / 1000, 0) * row.perSecond).toFixed(5)} USD for ${n} runs`);
    const go = pct(total, 95) < 3000;
    console.log(`  go/no-go (warm p95 < 3 s): ${go ? "GO" : "NO-GO"}`);
  }
}

try {
  await conformance();
} catch (err) {
  check("relay reachable", false, err.cause?.code || err.message);
}
if (MEASURE > 0) await measure(MEASURE);
process.exitCode = results.every(Boolean) ? 0 : 1;
