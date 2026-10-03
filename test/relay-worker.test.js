import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../deploy/relay-worker/src/index.js";
import { DECISION_MODELS, DEFAULT_DECISION_MODEL } from "../lib/decision-models.js";

const ORIGIN = "https://barakplasma.github.io";
const env = { ALLOWED_ORIGINS: `${ORIGIN},https://aura.526462738.xyz` };
const R8 = "Bearer r8_test0000";
const CF = "Bearer cftoken000000000000000000000000000000";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const CLEF = `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/cloudflare/clef`;
const pinned = DECISION_MODELS[DEFAULT_DECISION_MODEL].version;

// Every upstream call the worker makes, answered with a fixed 401 like a real
// API rejecting a test token.
function stubUpstream() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"detail":"unauthenticated"}', { status: 401, headers: { "Content-Type": "application/json", "Set-Cookie": "x=1" } });
  };
  return calls;
}

const call = (path, { method = "POST", headers = {}, body } = {}) =>
  worker.fetch(new Request(`https://relay.example${path}`, {
    method,
    headers: { Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }), env);

test("preflight answers CORS for Aura's origins only", async () => {
  const ok = await call("/v1/predictions", { method: "OPTIONS" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(ok.headers.get("Access-Control-Allow-Headers"), /authorization.*content-type.*prefer/);
  const evil = await worker.fetch(new Request("https://relay.example/v1/predictions", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env);
  assert.equal(evil.status, 404);
});

test("a pinned Replicate version is forwarded with only the needed headers", async () => {
  const calls = stubUpstream();
  const res = await call("/v1/predictions", {
    headers: { Authorization: R8, "Content-Type": "application/json", Prefer: "wait=15", Cookie: "secret=1", "X-Forwarded-For": "1.2.3.4" },
    body: { version: pinned, input: {} },
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.equal(calls[0].url, "https://api.replicate.com/v1/predictions");
  assert.deepEqual(calls[0].init.headers, { Authorization: R8, "Content-Type": "application/json", Prefer: "wait=15" });
});

test("any other Replicate version is refused, never forwarded", async () => {
  const calls = stubUpstream();
  for (const body of [{ version: "f".repeat(64), input: {} }, { input: {} }, "not json"]) {
    const res = await call("/v1/predictions", { headers: { Authorization: R8 }, body });
    assert.equal(res.status, 403);
  }
  assert.equal(calls.length, 0);
});

test("prediction poll and cancel go through; other Replicate paths don't", async () => {
  const calls = stubUpstream();
  assert.equal((await call("/v1/predictions/k1e8m6y00xrgc0d0rq", { method: "GET", headers: { Authorization: R8 } })).status, 401);
  assert.equal((await call("/v1/predictions/k1e8m6y00xrgc0d0rq/cancel", { headers: { Authorization: R8 } })).status, 401);
  assert.equal(calls.length, 2);
  for (const [path, method] of [["/v1/account", "GET"], ["/v1/predictions/../account", "GET"], ["/v1/predictions/k1e8m6y00xrgc0d0rq", "POST"]]) {
    assert.equal((await call(path, { method, headers: { Authorization: R8 } })).status, 404, path);
  }
  assert.equal(calls.length, 2);
});

test("Clef goes to the account's Workers AI URL; other models and Cloudflare APIs 404", async () => {
  const calls = stubUpstream();
  const ok = await call(CLEF, { headers: { Authorization: CF }, body: { model: "clef" } });
  assert.equal(ok.status, 401);
  assert.equal(calls[0].url, `https://api.cloudflare.com${CLEF}`);
  for (const path of [
    `/client/v4/accounts/${ACCOUNT}/ai/run/@cf/meta/llama-3.1-8b-instruct`,
    `/client/v4/accounts/${ACCOUNT}/workers/scripts`,
    "/client/v4/accounts/not-an-account/ai/run/@cf/cloudflare/clef",
  ]) {
    assert.equal((await call(path, { headers: { Authorization: CF }, body: {} })).status, 404, path);
  }
  assert.equal(calls.length, 1);
});

test("no token, a wrong-shaped token, another origin, or a 5 MB body is never forwarded", async () => {
  const calls = stubUpstream();
  assert.equal((await call("/v1/predictions", { body: { version: pinned } })).status, 404);
  assert.equal((await call("/v1/predictions", { headers: { Authorization: CF }, body: { version: pinned } })).status, 404);
  const other = await worker.fetch(new Request("https://relay.example/v1/predictions", {
    method: "POST", headers: { Origin: "https://evil.example", Authorization: R8 }, body: "{}",
  }), env);
  assert.equal(other.status, 404);
  assert.equal((await call("/v1/predictions", { headers: { Authorization: R8 }, body: "A".repeat(5_000_000) })).status, 413);
  assert.equal(calls.length, 0);
});
