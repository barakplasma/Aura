import {
  buildDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  isolateJsonObject,
  normalizeDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
  isLocalBaseUrl,
  sameOrigin,
} from "./monitor.js";

export {
  buildDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  isolateJsonObject,
  normalizeDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
  isLocalBaseUrl,
  sameOrigin,
};

export async function fetchModels(baseUrl, apiKey) {
  const base = (baseUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("Base URL is required.");
  let resp;
  try {
    resp = await fetch(`${base}/models`, {
      headers: providerHeaders(base, apiKey),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw unreachableProviderError(err, base);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      missingKeyHint(resp.status, apiKey) ||
        `Models endpoint HTTP ${resp.status}: ${detail.slice(0, 120)}`,
    );
  }
  const json = await resp.json();
  return (json?.data || []).map((m) => m.id).sort();
}

export async function scanClient({
  baseUrl,
  model,
  apiKey,
  mission,
  action,
  image,
  threshold = 60,
  webhookAction,
  webhookSchema,
  examples,
  optimizedInstruction,
  requestTimeout,
  signal,
}) {
  // No API-key check on purpose: a blank key is a valid configuration for a
  // local server (Ollama, LM Studio, llama.cpp), and the Authorization header
  // is simply omitted. A cloud provider's 401 is rewritten downstream into an
  // actionable "this provider requires an API key" message.
  if (!baseUrl) throw new Error("Provider base URL is required.");
  if (!model) throw new Error("Model name is required.");

  // Per-request timeout in seconds. `requestTimeout === null` means no forced
  // timeout at all (MAX mode — let a scan run to completion so the next one
  // starts immediately after, for maximum throughput); any other non-finite
  // value falls back to a 30s default.
  const noTimeout = requestTimeout === null;
  const timeoutSec = noTimeout
    ? null
    : Number.isFinite(requestTimeout) && requestTimeout > 0
      ? requestTimeout
      : 30;
  const cfg = {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    apiKey,
    timeoutMs: noTimeout ? null : timeoutSec * 1000,
    signal,
  };

  // Time the detection call specifically — it runs every cycle, so its latency
  // is the representative "time to process a frame" that drives the progress
  // estimate and the self-tuning timeout upstream.
  // performance.now() is monotonic — immune to system-clock adjustments that
  // could otherwise yield a negative or wildly wrong latency.
  const detStart = performance.now();
  const det = await callProvider(
    cfg,
    buildDetectionPrompt(mission, examples, optimizedInstruction),
    "Assess the scene now.",
    image,
    0.5,
  );
  const latencyMs = Math.round(performance.now() - detStart);
  const detection = normalizeDetection(isolateJsonObject(det.content));
  let usage = det.usage;

  const fired = detection.triggered && detection.confidence >= threshold;
  let message = "";
  let webhookMessage = "";
  if (fired) {
    if ((action || "").trim()) {
      const act = await callProvider(
        cfg,
        buildActionPrompt(
          action,
          detection.reason,
          examples,
          optimizedInstruction,
        ),
        "Produce the announcement.",
        image,
        0.9,
      );
      message = parseAction(act.content).message;
      usage = sumUsage(usage, act.usage);
    } else {
      message = detection.reason;
    }

    if ((webhookAction || "").trim()) {
      const wh = await callProvider(
        cfg,
        buildWebhookActionPrompt(
          webhookAction,
          detection.reason,
          webhookSchema,
        ),
        "Produce the webhook payload.",
        image,
        0.9,
      );
      webhookMessage = parseWebhookAction(wh.content).message;
      usage = sumUsage(usage, wh.usage);
    }
  }

  return {
    triggered: fired,
    confidence: detection.confidence,
    reason: detection.reason,
    message,
    webhookMessage,
    mode: "live",
    latencyMs,
    usage,
  };
}

async function callProvider(cfg, system, userText, image, temperature) {
  const body = {
    model: cfg.model,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: toDataUrl(image) } },
        ],
      },
    ],
    temperature,
  };
  // Native JSON mode when the provider supports it. Some local servers reject
  // the field outright — once we've seen that, stop asking for this session.
  const jsonModeKey = capabilityKey(cfg.baseUrl, cfg.model);
  if (!jsonModeUnsupported.has(jsonModeKey)) {
    body.response_format = { type: "json_object" };
  }

  let resp = await sendRequest(cfg, body);
  if (!resp.ok) {
    let detail = await resp.text().catch(() => "");
    // Retry once without JSON mode — isolateJsonObject() already digs the
    // object out of a prose-wrapped reply, so dropping it costs us nothing.
    if (body.response_format && rejectsJsonMode(resp.status, detail)) {
      jsonModeUnsupported.add(jsonModeKey);
      delete body.response_format;
      resp = await sendRequest(cfg, body);
      detail = resp.ok ? "" : await resp.text().catch(() => "");
    }
    if (!resp.ok) throw providerError(resp.status, detail, cfg.apiKey);
  }

  const json = await resp.json();
  return {
    content: json?.choices?.[0]?.message?.content,
    usage: normalizeUsage(json?.usage),
  };
}

async function sendRequest(cfg, body) {
  const controller = new AbortController();
  const timedOut = { hit: false };
  // No forced timeout at all when timeoutMs is null (MAX mode) — only the
  // caller's own abort signal (e.g. Stop) can cancel the request.
  const timeout =
    cfg.timeoutMs == null
      ? null
      : setTimeout(() => {
          timedOut.hit = true;
          controller.abort(
            new DOMException(
              `Request exceeded ${cfg.timeoutMs / 1000}s timeout`,
              "TimeoutError",
            ),
          );
        }, cfg.timeoutMs);

  // Chain the caller's signal (e.g. the user pressed Stop) so an in-flight
  // request is actually cancelled instead of running to completion in the
  // background and burning tokens.
  const external = cfg.signal;
  const onExternalAbort = () => controller.abort(external.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let resp;
  try {
    resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...providerHeaders(cfg.baseUrl, cfg.apiKey),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Our own timeout gets an actionable message — without this the browser
    // surfaces the opaque "signal is aborted without reason". An external
    // abort (Stop) propagates as-is so the caller can recognize and swallow it.
    if (timedOut.hit) {
      throw new Error(
        `Provider request timed out after ${cfg.timeoutMs / 1000}s (auto-tuned from recent response times). The model may be slow or unreachable — try MAX mode for no forced timeout, or switch to a faster provider/model.`,
      );
    }
    throw unreachableProviderError(err, cfg.baseUrl);
  } finally {
    if (timeout != null) clearTimeout(timeout);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
  return resp;
}

function sumUsage(a, b) {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

// (base URL × model) pairs that rejected `response_format: json_object`. Keyed
// per model, not per endpoint: an eval matrix runs several models against one
// base URL, and one model's refusal must not silently strip JSON mode from the
// rest. Session-only (module state), so a server that gains support just needs
// a page reload.
const jsonModeUnsupported = new Set();

// NUL never appears in a URL or a model name, so it can't collide.
// Mirrors comboKey() in lib/eval.js.
function capabilityKey(baseUrl, model) {
  return `${baseUrl}\u0000${model}`;
}

// Test hook — keeps the retry tests independent of execution order.
export function _resetJsonModeCache() {
  jsonModeUnsupported.clear();
}

// A blank API key is legitimate for a local server, so we no longer refuse to
// send the request — but if a provider answers 401/403 and we sent no key, the
// cause is unambiguous and worth spelling out. Returns null when it doesn't apply.
function missingKeyHint(status, apiKey) {
  if (apiKey || (status !== 401 && status !== 403)) return null;
  return `Provider API ${status} — this provider requires an API key. Add one in Settings.`;
}

function providerError(status, detail, apiKey) {
  return new Error(
    missingKeyHint(status, apiKey) ||
      `Provider API ${status}: ${(detail || "").slice(0, 200)}`,
  );
}

// A cross-origin fetch that never reached the server rejects with a bare
// TypeError ("Failed to fetch"), which tells a local-model user nothing. Name
// the two causes that account for nearly every case.
function unreachableProviderError(err, baseUrl) {
  if (!(err instanceof TypeError) || !isLocalBaseUrl(baseUrl)) return err;
  return new Error(
    `Could not reach ${baseUrl}. Check that the local server is running, and that it allows requests from this page (OLLAMA_ORIGINS='*' for Ollama, --cors for llama-server).`,
  );
}

// Whether a failed response looks like the server objecting to the
// `response_format` field itself rather than to the request as a whole.
function rejectsJsonMode(status, detail) {
  if (status < 400 || status >= 500) return false;
  return /response_format|json[_ ]?(mode|schema|object)/i.test(detail || "");
}

// Authorization is omitted entirely when there's no key — local servers need
// none, and `Bearer undefined` is worse than no header at all. Nothing else is
// added here either: with no key, a GET carrying only these headers stays a
// CORS-simple request, so a local server with minimal CORS handling never has
// to answer a preflight.
function providerHeaders(baseUrl, apiKey) {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...openRouterAttributionHeaders(baseUrl),
  };
}

// OpenRouter attributes usage to the calling app via these headers (site
// rankings/analytics); other providers just ignore unknown headers, but
// scope this to OpenRouter's own host to avoid sending it needlessly.
function openRouterAttributionHeaders(baseUrl) {
  if (!baseUrl.includes("openrouter.ai")) return {};
  return {
    "HTTP-Referer":
      typeof location !== "undefined"
        ? location.origin
        : "https://github.com/barakplasma/Aura",
    "X-Title": "Aura",
  };
}

function toDataUrl(image) {
  return image.startsWith("data:") ? image : `data:image/jpeg;base64,${image}`;
}
