import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanDecision,
  buildDecisionRequest,
  toDialectRequest,
  parseDecisionResponse,
  answerToDetection,
  expandRelayUrl,
  missionToQuestion,
  missionHash,
  templateQuestion,
  parseCompiledQuestion,
  decisionHttpError,
} from "../lib/decision.js";
import {
  DECISION_MODELS,
  DEFAULT_DECISION_MODEL,
  DEFAULT_RELAY_URL,
  defaultDecisionUrl,
} from "../lib/decision-models.js";
import { costForUsage, resolveDecisionPricing } from "../lib/pricing.js";
import { computeGapMs } from "../lib/scheduler.js";
import { sumUsage } from "../lib/monitor.js";

const IMAGE = "data:image/jpeg;base64,/9j/AAAA";
const QUESTION = { question: "Is a package on the doormat?", yes: "A package is visible", no: "No package" };
const glance = DECISION_MODELS["glance-qwen3-vl-4b"];
const server = DECISION_MODELS["systemone-server"];

// The default example on untapped/glance-qwen3-vl-4b's API page, read
// 2026-09-26, with the answer switched to a yes/no question.
const GLANCE_SUCCEEDED = {
  id: "k1e8m6y00xrgc0d0rqnrd8061w",
  status: "succeeded",
  metrics: { predict_time: 1.045235449, total_time: 1.072012067 },
  output: {
    answer: "Yes",
    confidence: 0.86,
    probabilities: [
      { label: "Yes", probability: 0.93 },
      { label: "No", probability: 0.07 },
    ],
  },
  urls: { get: "https://api.replicate.com/v1/predictions/k1e8m6y00xrgc0d0rqnrd8061w" },
};

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Records every call and answers from a script of responses, in order.
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

// --- rows ------------------------------------------------------------------

test("every row names a known dialect and pins what it calls", () => {
  assert.ok(DECISION_MODELS[DEFAULT_DECISION_MODEL]);
  for (const [id, row] of Object.entries(DECISION_MODELS)) {
    assert.ok(["replicate", "content"].includes(row.dialect), id);
    assert.ok(row.label, id);
    if (row.dialect === "replicate") {
      assert.match(row.version, /^[0-9a-f]{64}$/, `${id} must pin a full version id`);
      assert.ok(Number.isFinite(row.perSecond) && row.perSecond > 0, id);
      assert.equal(defaultDecisionUrl(row), DEFAULT_RELAY_URL);
    } else {
      assert.equal(row.upstream, null, id);
      assert.ok(defaultDecisionUrl(row).startsWith("http"), id);
    }
  }
});

// --- mission → question ------------------------------------------------------

test("explicit question wins, then a compiled one for the same mission, then the template", () => {
  const mission = "Tell me when a parcel is left at the door";
  const compiled = { question: "Is a parcel at the door?", yes: "parcel", no: "none", missionHash: missionHash(mission) };
  assert.equal(missionToQuestion({ mission, explicit: "  Is the door open?  ", compiled }).question, "Is the door open?");
  assert.equal(missionToQuestion({ mission, explicit: "", compiled }).source, "compiled");
  // A mission edit invalidates the compiled question.
  const stale = missionToQuestion({ mission: `${mission}!`, compiled });
  assert.equal(stale.source, "template");
  assert.equal(stale.question, `Does the image show the following? ${mission}!`);
  assert.deepEqual(missionToQuestion({ mission }), templateQuestion(mission));
});

test("parseCompiledQuestion digs JSON out of prose and stamps the mission hash", () => {
  const out = parseCompiledQuestion('Sure:\n```json\n{"question":"Is a parcel visible?","yes":"a parcel","no":""}\n```', "m");
  assert.deepEqual(out, { question: "Is a parcel visible?", yes: "a parcel", no: "No", missionHash: missionHash("m") });
  assert.throws(() => parseCompiledQuestion("no json here", "m"), /did not return a question/);
});

// --- adapters: golden request/response fixtures --------------------------------

test("replicate adapter: yes/no maps to question_type yes_no with plain base64", () => {
  const req = buildDecisionRequest({ image: IMAGE, context: "Front porch, daytime.", question: QUESTION });
  assert.deepEqual(toDialectRequest(glance, req), {
    version: glance.version,
    input: {
      question: "Is a package on the doormat?",
      question_type: "yes_no",
      image_base64: "/9j/AAAA",
    },
  });
  // A row whose Cog model takes context gets it as `state`.
  assert.equal(toDialectRequest(DECISION_MODELS["jev-omni"], req).input.state, "Front porch, daytime.");
});

test("replicate adapter: Glance output → System One answer, case-insensitive labels", () => {
  const req = buildDecisionRequest({ image: IMAGE, question: QUESTION });
  assert.deepEqual(parseDecisionResponse(glance, GLANCE_SUCCEEDED, req), {
    answers: { alert: { type: "choice", choice: "yes", confidence: 0.86, probabilities: { yes: 0.93, no: 0.07 } } },
    usage: { decisions: 1, predict_s: 1.045235449 },
    timing_ms: { predict: 1045 },
  });
  assert.throws(() => parseDecisionResponse(glance, { status: "failed", error: "CUDA OOM" }, req), /failed: CUDA OOM/);
  assert.throws(() => parseDecisionResponse(glance, { status: "succeeded", output: { answer: "Maybe" } }, req), /unknown option/);
});

test("content adapter: image as an OpenAI content part inside state, answers passed through", () => {
  const req = buildDecisionRequest({ image: "/9j/AAAA", context: "Porch", question: QUESTION });
  assert.deepEqual(toDialectRequest(server, req), {
    state: {
      content: [
        { type: "text", text: "Porch" },
        { type: "image_url", image_url: { url: IMAGE } },
      ],
    },
    questions: {
      alert: {
        type: "choice",
        instructions: "Is a package on the doormat?",
        criteria: { yes: "A package is visible", no: "No package" },
      },
    },
  });
  // Bonsai-Llama-Jev README shape: {"answers": {id: {choice, probabilities}}}.
  const parsed = parseDecisionResponse(server, { answers: { alert: { choice: "no", probabilities: { yes: 0.2, no: 0.8 } } } }, req);
  assert.deepEqual(parsed.answers.alert, { type: "choice", choice: "no", confidence: null, probabilities: { yes: 0.2, no: 0.8 } });
  assert.deepEqual(parsed.usage, { decisions: 1 });
});

// --- confidence semantics ------------------------------------------------------

test("confidence is round(100 × p(yes)), not the model's reported confidence", () => {
  const det = answerToDetection(glance, { choice: "no", confidence: 0.9, probabilities: { yes: 0.1, no: 0.9 } }, QUESTION);
  assert.equal(det.confidence, 10);
  assert.equal(det.triggered, false);
  assert.match(det.reason, /^p\(yes\) 0\.10 — Is a package/);
});

test("an uncalibrated row gets 100/0 from its answer", () => {
  const row = DECISION_MODELS["qwen3-vl-2b"];
  assert.equal(answerToDetection(row, { choice: "yes", confidence: null, probabilities: {} }, QUESTION).confidence, 100);
  assert.equal(answerToDetection(row, { choice: "no", confidence: null, probabilities: {} }, QUESTION).confidence, 0);
});

// --- relay ----------------------------------------------------------------------

test("relay URL templates", () => {
  const up = "https://api.replicate.com/v1/predictions";
  assert.equal(expandRelayUrl(DEFAULT_RELAY_URL, up), "https://aura-relay.526462738.xyz/v1/predictions");
  assert.equal(expandRelayUrl("https://proxy.corsfix.com/?{url}", up), `https://proxy.corsfix.com/?${up}`);
  assert.equal(expandRelayUrl("https://corsproxy.io/?url={url:encoded}", up), `https://corsproxy.io/?url=${encodeURIComponent(up)}`);
  assert.equal(expandRelayUrl("{url}", up), up);
  assert.equal(expandRelayUrl("", up), up);
  // No placeholder: a base URL, path appended.
  assert.equal(expandRelayUrl("https://my-relay.example/", up), "https://my-relay.example/v1/predictions");
});

// --- scanDecision ------------------------------------------------------------------

test("scanDecision: one Replicate call through the relay with the user's own token", async () => {
  const fetchImpl = fakeFetch([jsonResponse(GLANCE_SUCCEEDED, 201)]);
  const r = await scanDecision({
    modelId: "glance-qwen3-vl-4b",
    url: DEFAULT_RELAY_URL,
    apiKey: "r8_user",
    question: QUESTION,
    image: IMAGE,
    threshold: 0,
    fetchImpl,
    sleep: noSleep,
  });
  assert.equal(fetchImpl.calls.length, 1);
  const [call] = fetchImpl.calls;
  assert.equal(call.url, "https://aura-relay.526462738.xyz/v1/predictions");
  assert.equal(call.init.headers.Authorization, "Bearer r8_user");
  assert.equal(call.init.headers.Prefer, "wait=15");
  assert.equal(call.body.version, glance.version);
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 93);
  assert.equal(r.mode, "live");
  assert.equal(r.message, r.reason, "no action text: the reason is the announcement");
  assert.deepEqual(r.timing, { predict: 1045 });
  assert.equal(r.usage.decisions, 1);
  assert.equal(r.decision.reportedConfidence, 0.86);
});

test("scanDecision: a cold start polls the prediction through the relay until it succeeds", async () => {
  const fetchImpl = fakeFetch([
    jsonResponse({ id: "p1", status: "starting" }, 201),
    jsonResponse({ id: "p1", status: "processing" }),
    jsonResponse({ ...GLANCE_SUCCEEDED, id: "p1" }),
  ]);
  const r = await scanDecision({
    modelId: "glance-qwen3-vl-4b",
    url: DEFAULT_RELAY_URL,
    apiKey: "r8_user",
    question: QUESTION,
    image: IMAGE,
    fetchImpl,
    sleep: noSleep,
  });
  assert.deepEqual(fetchImpl.calls.map((c) => [c.init.method, c.url]), [
    ["POST", "https://aura-relay.526462738.xyz/v1/predictions"],
    ["GET", "https://aura-relay.526462738.xyz/v1/predictions/p1"],
    ["GET", "https://aura-relay.526462738.xyz/v1/predictions/p1"],
  ]);
  assert.equal(r.confidence, 93);
});

test("scanDecision: a timeout mid-poll cancels the prediction and says why", async () => {
  const fetchImpl = fakeFetch([
    jsonResponse({ id: "p2", status: "starting" }, 201),
    jsonResponse({}, 200),
  ]);
  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await assert.rejects(
    scanDecision({
      modelId: "glance-qwen3-vl-4b",
      url: "{url}",
      apiKey: "r8_user",
      question: QUESTION,
      image: IMAGE,
      requestTimeout: 0.05,
      fetchImpl,
      sleep,
    }),
    /timed out after 0.05s/,
  );
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(fetchImpl.calls.at(-1).url, "https://api.replicate.com/v1/predictions/p2/cancel");
});

test("scanDecision: 401 without a key asks for one; with a key, says it was rejected", async () => {
  const base = { modelId: "glance-qwen3-vl-4b", url: DEFAULT_RELAY_URL, question: QUESTION, image: IMAGE, sleep: noSleep };
  await assert.rejects(
    scanDecision({ ...base, fetchImpl: fakeFetch([jsonResponse({ detail: "Unauthenticated" }, 401)]) }),
    /requires an API key/,
  );
  await assert.rejects(
    scanDecision({ ...base, apiKey: "r8_bad", fetchImpl: fakeFetch([jsonResponse({}, 401)]) }),
    /rejected your key/,
  );
  // Blank key: no Authorization header at all.
  const fetchImpl = fakeFetch([jsonResponse({}, 401)]);
  await assert.rejects(scanDecision({ ...base, fetchImpl }));
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
});

test("scanDecision: a CORS failure names the relay, not 'Failed to fetch'", async () => {
  await assert.rejects(
    scanDecision({
      modelId: "glance-qwen3-vl-4b",
      url: "{url}",
      question: QUESTION,
      image: IMAGE,
      fetchImpl: fakeFetch([new TypeError("Failed to fetch")]),
      sleep: noSleep,
    }),
    /through a CORS relay/,
  );
  assert.match(decisionHttpError(404, "", "k").message, /no such route/);
});

test("scanDecision: self-hosted server is called directly at /v1/systemone", async () => {
  const fetchImpl = fakeFetch([jsonResponse({ answers: { alert: { choice: "yes", probabilities: { yes: 0.71, no: 0.29 } } } })]);
  const r = await scanDecision({
    modelId: "systemone-server",
    url: "http://localhost:54100/",
    question: QUESTION,
    image: IMAGE,
    fetchImpl,
    sleep: noSleep,
  });
  assert.equal(fetchImpl.calls[0].url, "http://localhost:54100/v1/systemone");
  assert.equal(r.confidence, 71);
  await assert.rejects(scanDecision({ modelId: "systemone-server", url: "", image: IMAGE, question: QUESTION }), /server URL is required/);
});

test("scanDecision: announcer speaks when fired; its failure falls back to the template, never losing the alert", async () => {
  const run = (announce) =>
    scanDecision({
      modelId: "glance-qwen3-vl-4b",
      url: "{url}",
      question: QUESTION,
      image: IMAGE,
      threshold: 0,
      action: "Say a parcel arrived.",
      webhookAction: "Summarise.",
      announce,
      fetchImpl: fakeFetch([jsonResponse(GLANCE_SUCCEEDED)]),
      sleep: noSleep,
    });
  const legs = [];
  const ok = await run(async (leg, { reason }) => {
    legs.push([leg, reason]);
    return { message: `${leg}!`, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, reported: true } };
  });
  assert.deepEqual(legs.map(([l]) => l), ["action", "webhook"]);
  assert.match(legs[0][1], /^p\(yes\) 0\.93/);
  assert.equal(ok.message, "action!");
  assert.equal(ok.webhookMessage, "webhook!");
  assert.equal(ok.usage.total_tokens, 30);
  assert.equal(ok.usage.decisions, 1, "decision usage survives summing the legs");

  const failed = await run(async () => {
    throw new Error("provider down");
  });
  assert.equal(failed.triggered, true);
  assert.equal(failed.message, "Say a parcel arrived.");
  assert.match(failed.webhookMessage, /^p\(yes\)/);
  assert.equal(failed.announceError, "provider down");
});

test("scanDecision: below threshold stays quiet and never announces", async () => {
  let announced = false;
  const r = await scanDecision({
    modelId: "glance-qwen3-vl-4b",
    url: "{url}",
    question: QUESTION,
    image: IMAGE,
    threshold: 95,
    action: "Say it.",
    announce: async () => {
      announced = true;
      return { message: "x", usage: {} };
    },
    fetchImpl: fakeFetch([jsonResponse(GLANCE_SUCCEEDED)]),
    sleep: noSleep,
  });
  assert.equal(r.triggered, false);
  assert.equal(announced, false);
});

// --- pricing + scheduling -------------------------------------------------------

test("decision cost is predict seconds × the row's hardware rate, plus announcer tokens", () => {
  const pricing = resolveDecisionPricing({ row: glance, providerPricing: { inputRate: 1, outputRate: 2 } });
  const usage = { prompt_tokens: 1e6, completion_tokens: 0, decisions: 1, predict_s: 1 };
  assert.ok(Math.abs(costForUsage(usage, pricing) - (1 + 0.000225)) < 1e-12);
  // No provider pricing known: the decision part still counts.
  const alone = resolveDecisionPricing({ row: glance, providerPricing: { inputRate: null, outputRate: null } });
  assert.ok(Math.abs(costForUsage(usage, alone) - 0.000225) < 1e-12);
  // Token-only callers are unchanged.
  assert.equal(costForUsage({ prompt_tokens: 1 }, { source: "unavailable" }), null);
  assert.equal(costForUsage({ decisions: 3 }, { perDecision: 0.001 }), 0.003);
});

test("budget mode throttles on a measured per-scan cost", () => {
  // $0.00022 a scan against $0.10/h → at most ~454 scans/h → ~7.9 s apart.
  const gap = computeGapMs("budget", { budgetPerHour: 0.1 }, { scanCost: 0.00022, durationMs: 0 });
  assert.equal(Math.round(gap), 7920);
});

test("sumUsage keeps decision fields only when present", () => {
  const tok = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, reported: true };
  assert.equal("decisions" in sumUsage(tok, tok), false);
  assert.equal(sumUsage({ ...tok, decisions: 1, predict_s: 0.5 }, tok).predict_s, 0.5);
});

test("scanDecision: a failed decision re-runs on the fallback and says why; Stop doesn't", async () => {
  const base = { modelId: "glance-qwen3-vl-4b", url: "{url}", question: QUESTION, image: IMAGE, sleep: noSleep };
  let fellBack = 0;
  const fallback = async () => {
    fellBack += 1;
    return { triggered: false, confidence: 5, reason: "provider says no", mode: "live" };
  };
  const r = await scanDecision({ ...base, fallback, fetchImpl: fakeFetch([jsonResponse("Service Unavailable", 503)]) });
  assert.equal(r.reason, "provider says no");
  assert.match(r.fallbackReason, /Decision API 503/);

  const stop = new AbortController();
  const fetchImpl = async () => {
    stop.abort();
    throw new DOMException("aborted", "AbortError");
  };
  await assert.rejects(scanDecision({ ...base, fallback, signal: stop.signal, fetchImpl }));
  assert.equal(fellBack, 1);
});

test("every relay preset carries a note, and lookups are by exact URL", async () => {
  const { RELAY_PRESETS, relayPresetFor } = await import("../lib/decision-models.js");
  for (const p of RELAY_PRESETS) assert.ok(p.note, p.id);
  assert.equal(relayPresetFor(DEFAULT_RELAY_URL).id, "operator");
  assert.equal(relayPresetFor("https://my.relay{path}"), null);
});
