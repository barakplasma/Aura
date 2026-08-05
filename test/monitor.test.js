import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  parseDetection,
  normalizeDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
  isLocalBaseUrl,
  sameOrigin,
} from "../lib/monitor.js";
import { scanClient, fetchModels, _resetJsonModeCache } from "../lib/aura.js";

// A minimal successful detection response, as the provider would return it.
function okCompletion() {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: '{"triggered":false,"confidence":0,"reason":"clear"}',
          },
        },
      ],
      usage: {},
    }),
  };
}

// Swap in a fetch stub that records each call's headers into `seenHeaders`.
// Returns the real fetch so the caller can restore it in a finally block.
function stubFetchCapturingHeaders(seenHeaders, reply = okCompletion) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    seenHeaders.push(opts.headers);
    return reply();
  };
  return realFetch;
}

test("buildDetectionPrompt embeds the mission and schema", () => {
  const p = buildDetectionPrompt("alert if a person is near the pool");
  assert.match(p, /alert if a person is near the pool/);
  assert.match(p, /"triggered": boolean/);
  assert.match(buildDetectionPrompt(""), /anything unusual/); // sensible default
});

test("buildActionPrompt embeds action and detected reason", () => {
  const p = buildActionPrompt("tell them to leave", "a person is loitering");
  assert.match(p, /tell them to leave/);
  assert.match(p, /a person is loitering/);
  assert.match(p, /"message": string/);
});

test("parseDetection coerces fields and clamps confidence", () => {
  const r = parseDetection(
    '```json\n{"triggered":true,"confidence":140,"reason":"  x  "}\n```',
  );
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 100);
  assert.equal(r.reason, "x");
});

test("normalizeDetection fills empty reason and coerces types", () => {
  const r = normalizeDetection({ triggered: 0, confidence: "45" });
  assert.equal(r.triggered, false);
  assert.equal(r.confidence, 45);
  assert.ok(r.reason.length > 0);
});

test("parseAction extracts and defaults the message", () => {
  assert.equal(
    parseAction('{"message":"Please leave."}').message,
    "Please leave.",
  );
  assert.ok(parseAction('{"message":""}').message.length > 0);
});

test("buildWebhookActionPrompt embeds action, reason, and optional schema", () => {
  const p = buildWebhookActionPrompt("send details", "intruder detected");
  assert.match(p, /send details/);
  assert.match(p, /intruder detected/);
  const withSchema = buildWebhookActionPrompt(
    "send details",
    "intruder detected",
    { type: "object", properties: { alert: { type: "string" } } },
  );
  assert.match(withSchema, /JSON Schema/);
  assert.match(withSchema, /"alert"/);
});

test("parseWebhookAction extracts and defaults the message", () => {
  assert.equal(
    parseWebhookAction('{"message":"Alert: intruder"}').message,
    "Alert: intruder",
  );
  assert.ok(parseWebhookAction('{"message":""}').message.length > 0);
});

test("normalizeUsage derives total tokens", () => {
  assert.deepEqual(
    normalizeUsage({ prompt_tokens: 560, completion_tokens: 40 }),
    {
      prompt_tokens: 560,
      completion_tokens: 40,
      total_tokens: 600,
    },
  );
});

test("scanClient still refuses to run without a provider (no silent mock)", async () => {
  await assert.rejects(
    scanClient({ mission: "watch the door", image: "x".repeat(64) }),
    /base URL/i,
  );
  await assert.rejects(
    scanClient({
      baseUrl: "http://localhost:11434/v1",
      mission: "watch the door",
      image: "x".repeat(64),
    }),
    /Model name/i,
  );
});

test("scanClient runs keyless against a local server and sends no Authorization", async () => {
  const seenHeaders = [];
  const realFetch = stubFetchCapturingHeaders(seenHeaders);
  try {
    const result = await scanClient({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5vl",
      apiKey: "",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(result.triggered, false);
    assert.equal("Authorization" in seenHeaders[0], false);

    // A configured key is still sent, unchanged.
    await scanClient({
      baseUrl: "https://api.cerebras.ai/v1",
      model: "gemma",
      apiKey: "csk-secret",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(seenHeaders[1].Authorization, "Bearer csk-secret");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchModels omits Authorization when no key is configured", async () => {
  const seenHeaders = [];
  const realFetch = stubFetchCapturingHeaders(seenHeaders, () => ({
    ok: true,
    json: async () => ({ data: [{ id: "b" }, { id: "a" }] }),
  }));
  try {
    const list = await fetchModels("http://localhost:11434/v1", "");
    assert.deepEqual(list, ["a", "b"]);
    assert.equal("Authorization" in seenHeaders[0], false);
    // Keyless, this GET must stay CORS-simple so a local server with minimal
    // CORS handling never has to answer a preflight.
    assert.deepEqual(seenHeaders[0], {});

    await fetchModels("https://api.cerebras.ai/v1", "csk-secret");
    assert.equal(seenHeaders[1].Authorization, "Bearer csk-secret");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 401 with no key configured explains that the provider needs one", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "invalid_api_key",
  });
  try {
    await assert.rejects(
      scanClient({
        baseUrl: "https://api.cerebras.ai/v1",
        model: "gemma",
        apiKey: "",
        mission: "watch the door",
        image: "x".repeat(64),
        requestTimeout: 30,
      }),
      /requires an API key/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("scanClient retries without response_format when the server rejects JSON mode", async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  _resetJsonModeCache();
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    if (bodies.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => 'unsupported parameter: "response_format"',
      };
    }
    return okCompletion();
  };
  try {
    const result = await scanClient({
      baseUrl: "http://localhost:8080/v1",
      model: "llava",
      apiKey: "",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(result.triggered, false);
    assert.equal(bodies.length, 2);
    assert.ok(bodies[0].response_format, "first attempt asks for JSON mode");
    assert.equal(bodies[1].response_format, undefined);

    // The rejection is remembered — no second round trip next scan.
    await scanClient({
      baseUrl: "http://localhost:8080/v1",
      model: "llava",
      apiKey: "",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(bodies.length, 3);
    assert.equal(bodies[2].response_format, undefined);

    // ...but only for that model. An eval matrix runs several models against
    // one base URL, so one model's refusal must not disable JSON mode for the
    // rest.
    await scanClient({
      baseUrl: "http://localhost:8080/v1",
      model: "qwen2.5vl",
      apiKey: "",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(bodies.length, 4);
    assert.ok(
      bodies[3].response_format,
      "a different model still gets JSON mode",
    );
  } finally {
    globalThis.fetch = realFetch;
    _resetJsonModeCache();
  }
});

test("an unrelated 4xx is not retried and surfaces the provider detail", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  _resetJsonModeCache();
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 404, text: async () => "model not found" };
  };
  try {
    await assert.rejects(
      scanClient({
        baseUrl: "http://localhost:11434/v1",
        model: "nope",
        apiKey: "",
        mission: "watch the door",
        image: "x".repeat(64),
        requestTimeout: 30,
      }),
      /Provider API 404: model not found/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
    _resetJsonModeCache();
  }
});

test("an unreachable local server names the likely causes", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  try {
    await assert.rejects(
      scanClient({
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5vl",
        apiKey: "",
        mission: "watch the door",
        image: "x".repeat(64),
        requestTimeout: 30,
      }),
      /Could not reach http:\/\/localhost:11434\/v1.*CORS|Could not reach.*OLLAMA_ORIGINS/s,
    );
    // A cloud provider keeps the raw error — the local hints wouldn't apply.
    await assert.rejects(
      scanClient({
        baseUrl: "https://api.cerebras.ai/v1",
        model: "gemma",
        apiKey: "k",
        mission: "watch the door",
        image: "x".repeat(64),
        requestTimeout: 30,
      }),
      /Failed to fetch/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("sameOrigin compares scheme, host and port", () => {
  const same = [
    ["http://localhost:11434/v1", "http://localhost:11434/v1"],
    ["http://localhost:11434/v1", "http://localhost:11434/openai/v1"],
    ["https://api.cerebras.ai/v1", "https://api.cerebras.ai/v1/"],
  ];
  for (const [a, b] of same) assert.equal(sameOrigin(a, b), true, `${a} ${b}`);

  const different = [
    ["http://localhost:11434/v1", "http://localhost:1234/v1"], // port
    ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1"], // host
    ["http://localhost:11434/v1", "https://localhost:11434/v1"], // scheme
    ["https://api.cerebras.ai/v1", "https://api.openai.com/v1"],
    // Unparseable input must never read as a match — that would skip clearing
    // the stored key when switching providers.
    ["", "https://api.cerebras.ai/v1"],
    ["not a url", "https://api.cerebras.ai/v1"],
    [undefined, "https://api.cerebras.ai/v1"],
  ];
  for (const [a, b] of different)
    assert.equal(sameOrigin(a, b), false, `${a} ${b}`);
});

test("isLocalBaseUrl recognizes loopback and LAN hosts", () => {
  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:1234/v1",
    "http://127.5.0.1/v1",
    "http://0.0.0.0:8080/v1",
    "http://[::1]:8080/v1",
    "http://nas.local:8080/v1",
    "http://10.0.0.4:11434/v1",
    "http://192.168.1.50:1234/v1",
    "http://172.16.0.9/v1",
    "http://172.31.255.1/v1",
  ]) {
    assert.equal(isLocalBaseUrl(url), true, url);
  }
  for (const url of [
    "https://api.cerebras.ai/v1",
    "https://openrouter.ai/api/v1",
    "https://notlocalhost.com/v1",
    "http://172.32.0.1/v1",
    "http://11.0.0.1/v1",
    "",
    "not a url",
  ]) {
    assert.equal(isLocalBaseUrl(url), false, url);
  }
});

test("scanClient surfaces a clear message when a slow provider times out", async () => {
  const realFetch = globalThis.fetch;
  // Simulate a provider that never responds before the request signal aborts,
  // rejecting the way fetch does on abort (name === 'AbortError').
  globalThis.fetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  try {
    await assert.rejects(
      scanClient({
        baseUrl: "http://localhost:11434/v1",
        model: "gemma",
        apiKey: "k",
        mission: "watch the door",
        image: "x".repeat(64),
        requestTimeout: 0.05,
      }),
      /timed out after 0\.05s/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("scanClient propagates an external abort (Stop) without the timeout message", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
    });
  const ac = new AbortController();
  try {
    const pending = scanClient({
      baseUrl: "http://localhost:11434/v1",
      model: "gemma",
      apiKey: "k",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
      signal: ac.signal,
    });
    ac.abort();
    await assert.rejects(pending, (err) => {
      assert.equal(err.name, "AbortError");
      assert.doesNotMatch(err.message, /timed out/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("scanClient applies no forced timeout when requestTimeout is null (MAX mode)", async () => {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  let timeoutScheduled = false;
  // Fail loudly if a forced-timeout timer is scheduled at all — MAX mode must
  // rely solely on the caller's own abort signal (Stop), never a TTL.
  globalThis.setTimeout = (...args) => {
    timeoutScheduled = true;
    return realSetTimeout(...args);
  };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            content: '{"triggered":false,"confidence":0,"reason":"clear"}',
          },
        },
      ],
      usage: {},
    }),
  });
  try {
    const result = await scanClient({
      baseUrl: "http://localhost:11434/v1",
      model: "gemma",
      apiKey: "k",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: null,
    });
    assert.equal(result.triggered, false);
    assert.equal(timeoutScheduled, false);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
});

test("scanClient sends OpenRouter attribution headers only for an OpenRouter baseUrl", async () => {
  const seenHeaders = [];
  const realFetch = stubFetchCapturingHeaders(seenHeaders);
  try {
    await scanClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "gemma",
      apiKey: "k",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(seenHeaders[0]["X-Title"], "Aura");
    assert.ok(seenHeaders[0]["HTTP-Referer"]);

    await scanClient({
      baseUrl: "https://api.cerebras.ai/v1",
      model: "gemma",
      apiKey: "k",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(seenHeaders[1]["X-Title"], undefined);
    assert.equal(seenHeaders[1]["HTTP-Referer"], undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});
