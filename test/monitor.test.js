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
} from "../lib/monitor.js";
import { scanClient } from "../lib/aura.js";

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

test("scanClient refuses to run without an API key (no silent mock)", async () => {
  await assert.rejects(
    scanClient({ mission: "watch the door", image: "x".repeat(64) }),
    /API key/,
  );
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
  const realFetch = globalThis.fetch;
  const seenHeaders = [];
  globalThis.fetch = async (_url, opts) => {
    seenHeaders.push(opts.headers);
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
  };
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
