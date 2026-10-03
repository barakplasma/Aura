// Aura's BYOK CORS relay as a Workers-module fetch handler
// (docs/PRD-decision-engine.md). Runs unchanged on Cloudflare Workers and on
// self-hosted celld (https://github.com/denoland/celld), so it uses nothing
// either one lacks: no `request.cf` geo fields, no rate-limit binding, no
// Workers AI binding. Country filtering and rate limiting stay in the zone's
// WAF, in front of whichever runtime serves the hostname.
//
// It forwards the caller's OWN token unchanged and holds no credential — a
// stored key would bill one account for every Aura user. Unlike the Traefik
// relay it replaces, it reads the body, so it forwards only the model versions
// Aura pins in lib/decision-models.js: the relay can't be used to run arbitrary
// Replicate models from this host.

import { DECISION_MODELS } from "../../../lib/decision-models.js";

const REPLICATE = "https://api.replicate.com";
const CLOUDFLARE = "https://api.cloudflare.com";
const MAX_BODY_BYTES = 4_000_000; // a 640x480 JPEG as base64 is ~100 KB

const rows = Object.values(DECISION_MODELS);
const REPLICATE_VERSIONS = new Set(rows.filter((r) => r.dialect === "replicate").map((r) => r.version));
const WORKERS_MODELS = new Set(rows.filter((r) => r.dialect === "workers-ai").map((r) => r.workersModel));

const REPLICATE_TOKEN = /^Bearer r8_[A-Za-z0-9]+$/;
const CLOUDFLARE_TOKEN = /^Bearer [A-Za-z0-9_-]{30,}$/;
const PREDICTION_ID = /^[a-z0-9]{10,64}$/;
const WORKERS_RUN = /^\/client\/v4\/accounts\/[0-9a-f]{32}\/ai\/run\/(@cf\/[a-z0-9-]+\/[a-z0-9.-]+)$/;

// Which upstream a request may go to, or null (→ 404, never forwarded).
// `checkBody` sees the parsed JSON for POSTs that create work.
export function route(method, path) {
  if (path === "/v1/predictions" && method === "POST") {
    return { upstream: REPLICATE, token: REPLICATE_TOKEN, checkBody: (b) => REPLICATE_VERSIONS.has(b?.version) };
  }
  const pred = path.match(/^\/v1\/predictions\/([^/]+)(\/cancel)?$/);
  if (pred && PREDICTION_ID.test(pred[1]) && method === (pred[2] ? "POST" : "GET")) {
    return { upstream: REPLICATE, token: REPLICATE_TOKEN };
  }
  const run = path.match(WORKERS_RUN);
  if (run && WORKERS_MODELS.has(run[1]) && method === "POST") {
    return { upstream: CLOUDFLARE, token: CLOUDFLARE_TOKEN, checkBody: (b) => b && typeof b === "object" };
  }
  return null;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST",
    "Access-Control-Allow-Headers": "authorization, content-type, prefer",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

const notFound = () => new Response("404 page not found", { status: 404 });

export default {
  async fetch(request, env) {
    const origins = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get("Origin");
    // Same rule as the Traefik relay: nothing but Aura's own pages, so a
    // naive scraper gets a 404 rather than an open proxy.
    if (!origin || !origins.includes(origin)) return notFound();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const url = new URL(request.url);
    const r = route(request.method, url.pathname);
    const auth = request.headers.get("Authorization") || "";
    if (!r || !r.token.test(auth)) return notFound();

    let body;
    if (request.method === "POST") {
      if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
        return new Response("body too large", { status: 413, headers: corsHeaders(origin) });
      }
      body = await request.text();
      if (body.length > MAX_BODY_BYTES) return new Response("body too large", { status: 413, headers: corsHeaders(origin) });
      if (r.checkBody) {
        let parsed;
        try {
          parsed = JSON.parse(body || "null");
        } catch {
          parsed = null;
        }
        if (!r.checkBody(parsed)) {
          return new Response("model not allowed through this relay", { status: 403, headers: corsHeaders(origin) });
        }
      }
    }

    // Only the headers the upstream needs: the caller's own token, the body
    // type, and Replicate's `Prefer: wait`. Nothing else crosses the relay.
    const headers = { Authorization: auth };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const prefer = request.headers.get("Prefer");
    if (prefer && /^wait=\d{1,2}$/.test(prefer)) headers.Prefer = prefer;

    const upstream = await fetch(`${r.upstream}${url.pathname}${url.search}`, { method: request.method, headers, body });
    const out = new Headers(corsHeaders(origin));
    const type = upstream.headers.get("Content-Type");
    if (type) out.set("Content-Type", type);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};
