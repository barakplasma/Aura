// Aura DECISION engine (docs/PRD-decision-engine.md).
//
// The detection leg goes to a typed-decision model: image + a yes/no question
// in, a probability per option out, from one forward pass. Inside Aura every
// decision is TypeSafe's System One shape — `state` + typed `questions` in,
// `answers` with per-option `probabilities` out. No gateway normalises the
// backends, so each wire dialect is a pair of pure functions here,
// `toRequest(row, request)` / `fromResponse(row, json)`, picked by the row's
// `dialect` (lib/decision-models.js).
//
// These models write no text, so the announcement and webhook legs are
// injected by the caller (`announce`) — the configured PROVIDER, the BROWSER
// model, or nothing, in which case the template below speaks. Decide and
// announce are split on purpose: an announcer failure never loses an alert
// the decision already fired.
//
// Plain fetch + AbortController, no DOM: runs under `node --test` with an
// injected `fetchImpl`.

import { DECISION_MODELS, getDecisionModel, isAccountId } from "./decision-models.js";
import { isLocalBaseUrl, runAlertLegs } from "./monitor.js";

// The one question every scan asks. A stable id, so a multi-question request
// (fan-out, later) can add siblings without renaming this one.
export const ALERT_QUESTION_ID = "alert";

// Cold starts are Replicate's problem to hold, up to this long per request;
// past it Aura polls. Short on purpose: a relay or hosted proxy with a 20 s
// cap must never hold a request open for a minute.
const PREFER_WAIT_S = 15;
const POLL_INTERVAL_MS = 1000;
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

// --- Mission → question --------------------------------------------------
// One yes/no question, always the mission text through this template — no
// network call, no separate question to write or keep in sync with the
// mission. (Aura used to also take an explicit override and a question
// compiled once by the provider; both added a field and a step without
// changing what got asked in practice, so they're gone.)

export function templateQuestion(mission) {
  const text = String(mission || "").trim();
  return {
    question: `Does the image show the following? ${text}`,
    yes: "The image shows this",
    no: "The image does not show this",
    source: "template",
  };
}

export function missionToQuestion({ mission } = {}) {
  return templateQuestion(mission);
}

// --- The internal System One request -------------------------------------

export function buildDecisionRequest({ image, context, question }) {
  if (!image) throw new Error("A camera frame is required.");
  if (!question?.question) throw new Error("A decision question is required.");
  const state = { image: toDataUrl(image) };
  const ctx = String(context || "").trim();
  if (ctx) state.context = ctx;
  return {
    state,
    questions: {
      [ALERT_QUESTION_ID]: {
        type: "choice",
        instructions: question.question,
        criteria: { yes: question.yes || "Yes", no: question.no || "No" },
      },
    },
  };
}

// --- Dialect adapters ------------------------------------------------------

// Replicate predictions for the Glance-shaped Cog models (Glance, Jev-Omni,
// the small CPU ports): one question per prediction, plain base64 image.
const replicate = {
  endpoint: (row) => `${row.upstream}/v1/predictions`,
  toRequest(row, request) {
    const [, q] = onlyQuestion(request);
    const labels = Object.keys(q.criteria);
    const yesNo = isYesNo(labels);
    const input = {
      question: q.instructions,
      question_type: yesNo ? "yes_no" : "choice",
      image_base64: stripDataUrl(request.state.image),
    };
    if (!yesNo) input.options_json = JSON.stringify(labels);
    if (row.acceptsState && request.state.context) input.state = request.state.context;
    return { version: row.version, input };
  },
  fromResponse(row, json, request) {
    if (json?.status === "failed" || json?.status === "canceled") {
      throw new Error(`Decision model ${json.status}: ${json.error || "no detail"}`);
    }
    const out = json?.output;
    if (!out || typeof out !== "object") {
      throw new Error("Decision model returned no output.");
    }
    const [id, q] = onlyQuestion(request);
    const labels = Object.keys(q.criteria);
    const probabilities = {};
    for (const p of Array.isArray(out.probabilities) ? out.probabilities : []) {
      const key = matchLabel(labels, p?.label);
      if (key && Number.isFinite(p?.probability)) probabilities[key] = p.probability;
    }
    const choice = matchLabel(labels, out.answer);
    if (!choice) throw new Error(`Decision model answered an unknown option: ${out.answer}`);
    const predictS = Number(json?.metrics?.predict_time);
    return {
      answers: {
        [id]: {
          type: "choice",
          choice,
          confidence: Number.isFinite(out.confidence) ? out.confidence : null,
          probabilities,
        },
      },
      usage: {
        decisions: 1,
        ...(Number.isFinite(predictS) ? { predict_s: predictS } : {}),
      },
      timing_ms: Number.isFinite(predictS) ? { predict: Math.round(predictS * 1000) } : {},
    };
  },
};

// TypeSafe System One as served by Bonsai-Llama-Jev: many questions per
// request, the image inside `state.content` as an OpenAI content part.
const content = {
  endpoint: (row, { url }) => `${url}/v1/systemone`,
  toRequest(row, request) {
    const parts = [];
    if (request.state.context) parts.push({ type: "text", text: request.state.context });
    parts.push({ type: "image_url", image_url: { url: request.state.image } });
    return {
      ...(row.serverModel ? { model: row.serverModel } : {}),
      state: { content: parts },
      questions: request.questions,
    };
  },
  fromResponse(row, json, request) {
    const answers = {};
    for (const [id, q] of Object.entries(request.questions)) {
      const a = json?.answers?.[id];
      if (!a) throw new Error(`Decision server returned no answer for "${id}".`);
      const labels = Object.keys(q.criteria);
      const probabilities = {};
      for (const [label, p] of Object.entries(a.probabilities || {})) {
        const key = matchLabel(labels, label);
        if (key && Number.isFinite(p)) probabilities[key] = p;
      }
      const choice = matchLabel(labels, a.choice);
      if (!choice) throw new Error(`Decision server answered an unknown option: ${a.choice}`);
      answers[id] = {
        type: "choice",
        choice,
        confidence: Number.isFinite(a.confidence) ? a.confidence : null,
        probabilities,
      };
    }
    return {
      answers,
      usage: { decisions: Object.keys(answers).length },
      timing_ms: json?.timing_ms && typeof json.timing_ms === "object" ? json.timing_ms : {},
    };
  },
};

// Cloudflare Workers AI's @cf/cloudflare/clef (verified against the live API,
// 2026-10-03): `images` must be data URIs, `state` is required, and the
// answers come back in /v1/systemone's shape inside `{ result }`. Criteria go
// out as `null`: clef-webcam's lesson is that latency (and here, billed
// input tokens) grows with prompt length, and the labels carry the meaning.
const workersAi = {
  endpoint: (row, { account }) => `${row.upstream}/client/v4/accounts/${account}/ai/run/${row.workersModel}`,
  toRequest(row, request) {
    const questions = {};
    for (const [id, q] of Object.entries(request.questions)) {
      questions[id] = { ...q, criteria: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, null])) };
    }
    return {
      model: "clef",
      state: request.state.context || "A live camera frame.",
      images: [request.state.image],
      questions,
    };
  },
  fromResponse(row, json, request) {
    const parsed = content.fromResponse(row, json?.result, request);
    const tokens = Number(json?.result?.usage?.input_tokens);
    if (Number.isFinite(tokens)) parsed.usage.decision_tokens = tokens;
    return parsed;
  },
};

export const ADAPTERS = { replicate, content, "workers-ai": workersAi };

function adapterFor(row) {
  const adapter = ADAPTERS[row?.dialect];
  if (!adapter) throw new Error(`No adapter for decision dialect: ${row?.dialect}`);
  return adapter;
}

// Where a row's request goes before any relay: the user's own server for a
// self-hosted row, the vendor's API (with the account in the path) otherwise.
export function decisionEndpoint(row, { url = "", account = "" } = {}) {
  return adapterFor(row).endpoint(row, { url: String(url).trim().replace(/\/+$/, ""), account: String(account).trim() });
}

export function toDialectRequest(row, request) {
  return adapterFor(row).toRequest(row, request);
}

export function parseDecisionResponse(row, json, request) {
  return adapterFor(row).fromResponse(row, json, request);
}

// --- Answer → Aura's detection --------------------------------------------

// Aura's confidence is p(yes), not the model's reported `confidence`: the
// slider compares against it, so threshold 60 means "alert when the model
// gives at least 60 % to yes". A model that returns no probabilities
// (`calibrated: false`) gets 100 or 0 from its answer alone.
export function answerToDetection(row, answer, question) {
  const pYes = answer.probabilities?.yes;
  const calibrated = row.calibrated !== false && Number.isFinite(pYes);
  const confidence = calibrated
    ? Math.round(100 * pYes)
    : answer.choice === "yes" ? 100 : 0;
  const reason = calibrated
    ? `p(yes) ${pYes.toFixed(2)} — ${question.question}`
    : `answered ${answer.choice} — ${question.question}`;
  return { triggered: answer.choice === "yes", confidence, reason };
}

// --- Relay ------------------------------------------------------------------

// The relay URL is a template, so one field covers the operator's Traefik
// (`https://relay.example{path}`), a hosted proxy (`https://proxy/?{url}`),
// or none at all (`{url}`). A template with no placeholder is a base URL and
// gets the path appended.
export function expandRelayUrl(template, upstreamUrl) {
  const t = String(template || "").trim().replace(/\/+$/, "") || "{url}";
  const u = new URL(upstreamUrl);
  const path = `${u.pathname}${u.search}`;
  if (/\{(path|url|url:encoded)\}/.test(t)) {
    return t
      .replace("{url:encoded}", encodeURIComponent(upstreamUrl))
      .replace("{url}", upstreamUrl)
      .replace("{path}", path);
  }
  return `${t}${path}`;
}

// --- Scan -------------------------------------------------------------------

export async function scanDecision({
  modelId,
  url,
  account,
  apiKey,
  mission,
  question,
  image,
  threshold = 60,
  action,
  webhookAction,
  sceneHint,
  announce,
  fallback,
  requestTimeout,
  signal,
  onStage,
  fetchImpl = globalThis.fetch,
  sleep = abortableSleep,
} = {}) {
  // A cold start or outage must never silence the monitor: with `fallback`
  // (the PROVIDER engine, when the operator keeps it on) a failed decision
  // re-runs this scan there. Stop is not a failure.
  if (fallback) {
    try {
      return await scanDecision({ modelId, url, account, apiKey, mission, question, image, threshold, action, webhookAction, sceneHint, announce, requestTimeout, signal, onStage, fetchImpl, sleep });
    } catch (err) {
      if (signal?.aborted) throw err;
      const res = await fallback();
      return { ...res, fallbackReason: String(err?.message || err) };
    }
  }
  const row = getDecisionModel(modelId);
  if (!row) throw new Error(`Unknown decision model: ${modelId}`);
  // No key check: a self-hosted server may need none. Replicate's own 401 is
  // rewritten below into the same actionable hint the PROVIDER engine gives.
  const target = String(url || "").trim();
  if (!row.upstream && !target) throw new Error("Decision server URL is required.");
  // The account ID goes into the request path; nothing but an ID may.
  if (row.needsAccount && !isAccountId(account)) throw new Error("A Cloudflare account ID (32 hex characters) is required — add it in Settings.");
  const q = question || templateQuestion(mission);
  const request = buildDecisionRequest({ image, context: sceneHint, question: q });

  const timeoutMs =
    requestTimeout === null
      ? null
      : (Number.isFinite(requestTimeout) && requestTimeout > 0 ? requestTimeout : 30) * 1000;
  const deadline = withDeadline(signal, timeoutMs);
  const http = { fetchImpl, apiKey, deadline, sleep };

  const started = performance.now();
  onStage?.("detecting");
  let json;
  try {
    json = row.dialect === "replicate"
      ? await runReplicate(row, target, toDialectRequest(row, request), http)
      : await postJson(http, decisionTarget(row, { url: target, account }), toDialectRequest(row, request));
  } catch (err) {
    throw deadline.timedOut()
      ? new Error(
          `Decision request timed out after ${timeoutMs / 1000}s. A cold Replicate worker can take minutes to boot — try MAX mode, or keep the provider fallback on.`,
        )
      : err;
  } finally {
    deadline.clear();
  }
  const latencyMs = Math.round(performance.now() - started);
  const parsed = parseDecisionResponse(row, json, request);
  const answer = parsed.answers[ALERT_QUESTION_ID];
  const detection = answerToDetection(row, answer, q);

  let announceError = null;
  const template = (leg) => ({
    message: leg === "action" ? String(action || "").trim() : detection.reason,
    usage: zeroUsage(),
  });
  const { fired, message, webhookMessage, usage } = await runAlertLegs({
    detection,
    threshold,
    action,
    webhookAction,
    usage: { ...zeroUsage(), ...parsed.usage },
    onStage,
    runLeg: async (leg) => {
      if (!announce) return template(leg);
      try {
        return await announce(leg, { reason: detection.reason, image, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        // The decision already fired; losing the alert because the
        // announcer is down would be worse than a plainer announcement.
        announceError = String(err?.message || err);
        return template(leg);
      }
    },
  });

  return {
    triggered: fired,
    confidence: detection.confidence,
    reason: detection.reason,
    message,
    webhookMessage,
    mode: "live",
    latencyMs,
    usage,
    timing: Object.keys(parsed.timing_ms).length ? parsed.timing_ms : null,
    decision: {
      model: modelId,
      choice: answer.choice,
      probabilities: answer.probabilities,
      // The model's own confidence, kept as telemetry only.
      reportedConfidence: answer.confidence,
      question: q.question,
      questionSource: q.source || null,
    },
    announceError,
  };
}

// The URL a non-Replicate request is actually sent to: through the relay
// template for a hosted row, straight to the server for a self-hosted one.
export function decisionTarget(row, { url, account }) {
  const endpoint = decisionEndpoint(row, { url, account });
  return row.upstream ? expandRelayUrl(url, endpoint) : endpoint;
}

// Create, then poll until terminal. A prediction abandoned by a timeout or
// Stop is cancelled best-effort, so a slow cold start doesn't keep billing.
async function runReplicate(row, relay, body, http) {
  const through = (upstreamUrl) => expandRelayUrl(relay, upstreamUrl);
  const created = await postJson(http, through(replicate.endpoint(row)), body, {
    Prefer: `wait=${preferWaitSeconds(http.deadline)}`,
  });
  let prediction = created;
  try {
    while (!TERMINAL.has(prediction?.status)) {
      if (!prediction?.id) throw new Error("Replicate returned no prediction id.");
      await http.sleep(POLL_INTERVAL_MS, http.deadline.signal);
      prediction = await requestJson(http, through(`${row.upstream}/v1/predictions/${prediction.id}`), { method: "GET" });
    }
  } catch (err) {
    if (prediction?.id && http.deadline.signal.aborted) {
      const cancel = withDeadline(null, 5000);
      requestJson({ ...http, deadline: cancel }, through(`${row.upstream}/v1/predictions/${prediction.id}/cancel`), { method: "POST" })
        .catch(() => {})
        .finally(() => cancel.clear());
    }
    throw err;
  }
  return prediction;
}

function preferWaitSeconds(deadline) {
  const left = deadline.remainingMs();
  if (left == null) return PREFER_WAIT_S;
  return Math.max(1, Math.min(PREFER_WAIT_S, Math.floor(left / 1000) - 1));
}

function postJson(http, target, body, extraHeaders = {}) {
  return requestJson(http, target, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

async function requestJson(http, target, init) {
  let resp;
  try {
    resp = await http.fetchImpl(target, {
      ...init,
      headers: {
        ...(init.headers || {}),
        // Omitted entirely when blank — a self-hosted server may need none.
        ...(http.apiKey ? { Authorization: `Bearer ${http.apiKey}` } : {}),
      },
      signal: http.deadline.signal,
    });
  } catch (err) {
    if (http.deadline.signal.aborted) throw err;
    throw unreachableError(err, target);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw decisionHttpError(resp.status, detail, http.apiKey);
  }
  return resp.json();
}

export function decisionHttpError(status, detail, apiKey) {
  if (status === 401 || status === 403) {
    return new Error(
      apiKey
        ? `Decision API ${status} — the endpoint rejected your key. Check the DECISION key in Settings.`
        : `Decision API ${status} — this endpoint requires an API key. Add your own in Settings.`,
    );
  }
  if (status === 404) {
    return new Error(
      `Decision API 404 — the relay or server has no such route. Check the DECISION URL in Settings. ${String(detail || "").slice(0, 120)}`.trim(),
    );
  }
  if (status === 422) {
    // Replicate validates the input against the version's own schema before
    // creating a prediction. "image is required" means the pinned version
    // predates the Optional[Path] fix in deploy/replicate — a stale pin in
    // lib/decision-models.js, not anything the operator can fix in Settings.
    const text = String(detail || "").slice(0, 200);
    return new Error(
      /image is required/i.test(text)
        ? `Decision API 422 — this model version rejects image_base64 (“image is required”): the version pinned in lib/decision-models.js is stale. Run scripts/replicate-pins-check.mjs and pin the latest push.`
        : `Decision API 422 — the model rejected the input: ${text}`.trim(),
    );
  }
  return new Error(`Decision API ${status}: ${String(detail || "").slice(0, 200)}`);
}

// A fetch that never reached a server rejects with a bare TypeError. For a
// browser that almost always means CORS (no relay, or a relay that doesn't
// allow this origin) or a server that isn't up. Through a relay the URL is
// usually fine and the relay itself isn't answering with CORS headers — a
// Cloudflare challenge page in front of it looks exactly like this — so the
// message doesn't send the operator off to "fix" a correct `{path}` URL.
function unreachableError(err, target) {
  if (!(err instanceof TypeError)) return err;
  let origin = target;
  try {
    origin = new URL(target).origin;
  } catch {}
  if (isLocalBaseUrl(target))
    return new Error(`Could not reach ${origin}. Check that the server is running and allows this page's origin (--cors-origins).`);
  if (Object.values(DECISION_MODELS).some((row) => row.upstream === origin))
    return new Error(`Could not reach ${origin}. A browser can only call it through a CORS relay — check the DECISION URL in Settings.`);
  return new Error(
    `Could not reach ${origin}: it sent no CORS answer. The relay may be down, or something in front of it (a Cloudflare challenge, for one) is blocking browser requests.`,
  );
}

// One AbortController that fires on the caller's signal or on our own
// deadline, whichever comes first; `timedOut()` tells them apart.
function withDeadline(external, timeoutMs) {
  const controller = new AbortController();
  let hit = false;
  const endsAt = timeoutMs == null ? null : Date.now() + timeoutMs;
  const timer =
    timeoutMs == null
      ? null
      : setTimeout(() => {
          hit = true;
          controller.abort(new DOMException(`Request exceeded ${timeoutMs / 1000}s timeout`, "TimeoutError"));
        }, timeoutMs);
  const onAbort = () => controller.abort(external.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => hit,
    remainingMs: () => (endsAt == null ? null : Math.max(0, endsAt - Date.now())),
    clear() {
      if (timer != null) clearTimeout(timer);
      if (external) external.removeEventListener("abort", onAbort);
    },
  };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// --- utils --------------------------------------------------------------------

function onlyQuestion(request) {
  const entries = Object.entries(request.questions || {});
  if (entries.length !== 1) {
    throw new Error("This dialect takes exactly one question per request.");
  }
  return entries[0];
}

function isYesNo(labels) {
  return labels.length === 2 && labels.includes("yes") && labels.includes("no");
}

// Backends echo labels in their own case ("Yes"); map back to our keys.
function matchLabel(labels, label) {
  const want = String(label ?? "").trim().toLowerCase();
  return labels.find((l) => l.toLowerCase() === want) || null;
}

function zeroUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reported: false };
}

function toDataUrl(image) {
  return image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
}

function stripDataUrl(image) {
  return image.startsWith("data:") ? image.slice(image.indexOf(",") + 1) : image;
}
