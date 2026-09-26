import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDetectionPrompt,
  buildActionPrompt,
  buildWebhookActionPrompt,
  buildCompactDetectionPrompt,
  buildCompactActionPrompt,
  buildCompactWebhookActionPrompt,
  parseCompactAction,
  parseDetection,
  parseLooseDetection,
  normalizeDetection,
  parseAction,
  parseWebhookAction,
  normalizeUsage,
  runAlertLegs,
  isLocalBaseUrl,
  sameOrigin,
} from "../lib/monitor.js";
import { scanClient, fetchModels, _resetJsonModeCache } from "../lib/aura.js";
import { reportUnexpectedError } from "../lib/handled-errors.js";
import { encodeNtfyHeader, isHostedNtfyTopicUrl } from "../lib/ntfy.js";

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

test("handled provider failures are reported, while Stop aborts stay quiet", () => {
  const calls = [];
  const providerError = new Error("Provider API 400: unsupported temperature");
  assert.equal(
    reportUnexpectedError(providerError, (...args) => calls.push(args), { area: "live-monitor" }),
    true,
  );
  assert.deepEqual(calls, [[providerError, { area: "live-monitor" }]]);

  const abort = new DOMException("Stopped", "AbortError");
  assert.equal(reportUnexpectedError(abort, (...args) => calls.push(args)), false);
  assert.equal(calls.length, 1);
});

test("ntfy image attachments are restricted to hosted ntfy topic URLs", () => {
  assert.equal(isHostedNtfyTopicUrl("https://ntfy.sh/aura-alerts"), true);
  assert.equal(isHostedNtfyTopicUrl("https://ntfy.sh"), false);
  assert.equal(isHostedNtfyTopicUrl("https://example.com/hooks/ntfy"), false);
});

test("ntfy header encoding supports Unicode alerts without raw newlines", () => {
  const encoded = encodeNtfyHeader("\u05d0\u05d6\u05e2\u05e7\u05d4 \ud83d\udea8\ncheck camera");
  assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
  assert.equal(encoded.includes("\n"), false);
});

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

test("parseAction falls back to the raw reply when there's no JSON object", () => {
  // A small in-browser model rarely emits JSON — use its prose verbatim
  // rather than the generic fallback.
  assert.equal(
    parseAction("Please leave the area immediately.").message,
    "Please leave the area immediately.",
  );
  assert.equal(
    parseAction("  wrapped in whitespace  ").message,
    "wrapped in whitespace",
  );
});

test("parseAction only uses the generic fallback for an empty reply", () => {
  assert.equal(parseAction("").message, "Attention please.");
  assert.equal(parseAction("   ").message, "Attention please.");
  assert.equal(parseAction(null).message, "Attention please.");
});

test("buildCompactDetectionPrompt embeds the mission and answer format", () => {
  const p = buildCompactDetectionPrompt("a person is at the door");
  assert.match(p, /a person is at the door/);
  assert.match(p, /YES or NO/);
  assert.match(buildCompactDetectionPrompt(""), /anything unusual/);
  assert.match(buildCompactDetectionPrompt(), /anything unusual/);
});

test("parseLooseDetection still parses the strict JSON schema", () => {
  const r = parseLooseDetection(
    '{"triggered":true,"confidence":90,"reason":"a person at the door"}',
  );
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 90);
  assert.equal(r.reason, "a person at the door");
});

test("parseLooseDetection parses a loose YES/NO line", () => {
  const r = parseLooseDetection("YES 80 someone at the door");
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 80);
  assert.equal(r.reason, "someone at the door");

  const r2 = parseLooseDetection("no, 5, nothing happening here");
  assert.equal(r2.triggered, false);
  assert.equal(r2.confidence, 5);
  assert.equal(r2.reason, "nothing happening here");
});

// The observation-first compact prompt puts the verdict at the END of the
// answer, and sometimes on a second line. Measured on the reference phone:
// with the verdict-at-the-front prompt the 500M model answered the single
// token "YES" to every mission, including "a bicycle with a front basket"
// pointed at a shelf of books.
test("parseLooseDetection reads a verdict at the end of an observation", () => {
  const r = parseLooseDetection("books and papers on a desk, no person NO 10");
  assert.equal(r.triggered, false);
  assert.equal(r.confidence, 10);
  assert.equal(r.reason, "books and papers on a desk, no person");
});

test("parseLooseDetection reads a verdict on a later line than the observation", () => {
  const r = parseLooseDetection("a dark binder standing on the shelf\nYES 70 book visible");
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 70);
});

// The number is what tells the two apart: a trailing "no" inside the reason
// must not be mistaken for the verdict.
test("parseLooseDetection keeps the numbered verdict over a later no", () => {
  const r = parseLooseDetection("YES 90 no one else in frame");
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 90);
  assert.equal(r.reason, "no one else in frame");
});

test("parseLooseDetection tolerates extra whitespace/punctuation and missing parts", () => {
  const r = parseLooseDetection("  YES.\n");
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 100); // no confidence given — defaults from triggered
  assert.ok(r.reason.length > 0);

  const r2 = parseLooseDetection("no");
  assert.equal(r2.triggered, false);
  assert.equal(r2.confidence, 0);
});

test("parseLooseDetection degrades to sensible defaults on garbage input, never throws", () => {
  for (const bad of ["", "   ", "asdkjaskjd nonsense", null, undefined, "{}", "{malformed"]) {
    const r = parseLooseDetection(bad);
    assert.equal(typeof r.triggered, "boolean");
    assert.ok(Number.isFinite(r.confidence));
    assert.equal(typeof r.reason, "string");
  }
});

// --- Small-model failure modes (BROWSER engine: Qwen3.5, SmolVLM2) --------

test("normalizeDetection reads string booleans instead of coercing them to true", () => {
  // Boolean("false") is true — a small model answering {"triggered":"false"}
  // must not fire the alert.
  assert.equal(normalizeDetection({ triggered: "false", confidence: 80 }).triggered, false);
  assert.equal(normalizeDetection({ triggered: "no", confidence: 80 }).triggered, false);
  assert.equal(normalizeDetection({ triggered: "true", confidence: 80 }).triggered, true);
  assert.equal(normalizeDetection({ triggered: "yes", confidence: 80 }).triggered, true);
});

test("normalizeDetection scales a strictly-fractional 0-1 confidence up to percent", () => {
  // The schema asks for 0-100, but small models sometimes answer on a 0-1
  // scale. Strictly between 0 and 1 can only be a fraction; exactly 0 or 1
  // keeps its percent meaning.
  assert.equal(normalizeDetection({ triggered: true, confidence: 0.91 }).confidence, 91);
  assert.equal(normalizeDetection({ triggered: true, confidence: "0.4" }).confidence, 40);
  assert.equal(normalizeDetection({ triggered: true, confidence: 1 }).confidence, 1);
  assert.equal(normalizeDetection({ triggered: true, confidence: 100 }).confidence, 100);
  assert.equal(normalizeDetection({ triggered: true }).confidence, 100); // missing → default
});

test("normalizeDetection clamps out-of-range confidence", () => {
  assert.equal(normalizeDetection({ triggered: true, confidence: 130 }).confidence, 100);
  assert.equal(normalizeDetection({ triggered: true, confidence: -5 }).confidence, 0);
});

test("parseLooseDetection ignores a <think> block before the answer", () => {
  // The block's own braces must not feed the JSON slice.
  const r = parseLooseDetection(
    '<think>\nLet me check: {"score": 3, "why": "door"}\n</think>\n{"triggered":true,"confidence":85,"reason":"a person at the door"}',
  );
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 85);
  assert.equal(r.reason, "a person at the door");

  // Braces-free thinking is already sliceable, but strip it all the same.
  const r2 = parseLooseDetection(
    '<think>Reasoning about the scene.</think>\n{"triggered":false,"confidence":5,"reason":"empty room"}',
  );
  assert.equal(r2.triggered, false);
  assert.equal(r2.confidence, 5);
});

test("parseLooseDetection treats an unterminated <think> as no answer", () => {
  // Generation truncated mid-think: nothing after it is an answer.
  const r = parseLooseDetection('<think>The scene shows');
  assert.equal(r.triggered, false);
  assert.equal(r.confidence, 0);
});

test("parseLooseDetection parses fenced JSON wrapped in prose (regression)", () => {
  const r = parseLooseDetection(
    'Sure! Here is the result:\n```json\n{"triggered":false,"confidence":10,"reason":"empty room"}\n```\nHope that helps.',
  );
  assert.equal(r.triggered, false);
  assert.equal(r.confidence, 10);
  assert.equal(r.reason, "empty room");
});

test("parseLooseDetection reads a YES line buried under thinking output (regression)", () => {
  const r = parseLooseDetection("<think>hmm {oops</think>\n\nYES 70 package on the doorstep");
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 70);
  assert.equal(r.reason, "package on the doorstep");
});

test("buildCompactDetectionPrompt asks for the format SmolVLM is post-trained on", () => {
  const p = buildCompactDetectionPrompt("a stack of books");
  assert.match(p, /does this image satisfy the mission/);
  assert.match(p, /Answer with YES or NO first/);
  assert.match(p, /Confidence: 0-100/);
  // The example answers NO: a YES example is what fed the always-YES bias.
  assert.match(p, /Example: NO, Confidence: 10, Explanation: books/);
});

test("parseLooseDetection reads the Answer/Confidence/Explanation format", () => {
  const r = parseLooseDetection(
    "Answer: YES, Confidence: 82, Explanation: a stack of books on the shelf",
  );
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 82);
  assert.equal(r.reason, "a stack of books on the shelf");

  const multi = parseLooseDetection(
    "Answer: NO\nConfidence: 8\nExplanation: papers and a laptop, no bicycle",
  );
  assert.equal(multi.triggered, false);
  assert.equal(multi.confidence, 8);
  assert.equal(multi.reason, "papers and a laptop, no bicycle");
});

test("parseLooseDetection reads the verdict-first form the prompt asks for", () => {
  const r = parseLooseDetection(
    "NO, Confidence: 10, Explanation: books and papers on a desk",
  );
  assert.equal(r.triggered, false);
  assert.equal(r.confidence, 10);
  assert.equal(r.reason, "books and papers on a desk");

  const yes = parseLooseDetection("YES, Confidence: 95, Explanation: a stack of books");
  assert.equal(yes.triggered, true);
  assert.equal(yes.confidence, 95);
  assert.equal(yes.reason, "a stack of books");
});

test("parseLooseDetection prefers a named Confidence over position guessing", () => {
  // The loose scan alone cannot use this number: no digit sits next to YES,
  // so confidence would default to 100 and the labels would be spoken.
  const r = parseLooseDetection("Answer: YES, Confidence: 20, Explanation: maybe");
  assert.equal(r.confidence, 20);
  assert.equal(r.reason, "maybe");
  assert.ok(!/confidence/i.test(r.reason));
});

test("parseLooseDetection does not read the echoed format line as an answer", () => {
  const r = parseLooseDetection("Answer: YES or NO, Confidence: 0-100");
  assert.equal(r.triggered, false);
});

test("parseLooseDetection defaults confidence when the model omits it", () => {
  const r = parseLooseDetection("Answer: YES, Explanation: person at the door");
  assert.equal(r.triggered, true);
  assert.equal(r.confidence, 100);
  assert.equal(r.reason, "person at the door");

  const no = parseLooseDetection("Answer: NO.");
  assert.equal(no.triggered, false);
  assert.equal(no.confidence, 0);
});

test("parseLooseDetection stays conservative on a caption that ignores the question", () => {
  // Verbatim output from the 500M on the reference phone when asked about a
  // bicycle while looking at a shelf of books.
  const r = parseLooseDetection("Mark down the information visible in the image.");
  assert.equal(r.triggered, false);
  assert.equal(r.confidence, 0);
  assert.ok(r.reason.length > 0);
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
      reported: true,
    },
  );
});

test("normalizeUsage distinguishes omitted provider usage from a reported zero", () => {
  assert.deepEqual(normalizeUsage(), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    reported: false,
  });
  assert.deepEqual(normalizeUsage({ total_tokens: 0 }), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    reported: true,
  });
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

test("scanClient leaves temperature to the provider default", async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return okCompletion();
  };
  try {
    await scanClient({
      baseUrl: "https://api.openai.com/v1",
      model: "luna",
      mission: "watch the door",
      image: "x".repeat(64),
      requestTimeout: 30,
    });
    assert.equal(Object.hasOwn(bodies[0], "temperature"), false);
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

test("fetchModels asks OpenRouter for image-input models and keeps only declared VLMs", async () => {
  const realFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({ data: [
        { id: "vision", architecture: { input_modalities: ["text", "image"] } },
        { id: "text-only", architecture: { input_modalities: ["text"] } },
      ] }),
    };
  };
  try {
    const list = await fetchModels("https://openrouter.ai/api/v1", "key", { visionOnly: true });
    assert.equal(requestedUrl, "https://openrouter.ai/api/v1/models?input_modalities=image");
    assert.deepEqual(list, ["vision"]);
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

test("buildCompactActionPrompt is short, schema-free and carries the instruction", () => {
  const p = buildCompactActionPrompt("Tell them to move back", "a person at the door");
  assert.match(p, /Tell them to move back/);
  assert.match(p, /a person at the door/);
  assert.doesNotMatch(p, /Schema:|minified JSON/i);
  assert.ok(p.split("\n").length <= 6);
});

// Measured on the reference phone: asked for strict JSON, the 500M compact
// model obliged with a lone `{`, so the sink received `{"message":"{"}`.
// The compact webhook prompt must ask for prose; only the prohibition may
// mention JSON.
test("buildCompactWebhookActionPrompt asks for a sentence, never an object", () => {
  const p = buildCompactWebhookActionPrompt("Say what you saw", "a person on the bench");
  assert.match(p, /Say what you saw/);
  assert.match(p, /a person on the bench/);
  assert.doesNotMatch(p, /Schema:|minified JSON/i);
  assert.equal((p.match(/JSON/g) || []).length, 1, "JSON appears only in the prohibition");
  assert.ok(p.split("\n").length <= 6);
});

test("parseCompactAction drops a prompt echo and falls back to the reason", () => {
  const echo =
    "The alert condition was just met. The operator instruction for the response was \"What they look like\".";
  const r = parseCompactAction(echo, "a bearded man is close to the camera");
  assert.equal(r.message, "a bearded man is close to the camera");
});

test("parseCompactAction keeps a real answer, unwrapping labels and quotes", () => {
  assert.equal(
    parseCompactAction('Message: "Please step back from the door."', "x").message,
    "Please step back from the door.",
  );
  assert.equal(
    parseCompactAction("Please step back.\nYou can see: a person", "x").message,
    "Please step back.",
  );
});

test("parseCompactAction uses the generic fallback when echo and reason are both empty", () => {
  assert.equal(parseCompactAction("Schema: {\"message\": string}", "").message, "Attention please.");
  assert.equal(parseCompactAction("", null).message, "Attention please.");
});

test("parseAction's prose fallback no longer speaks a prompt echo", () => {
  const echo = "You are the announcement generator for an automated monitor.";
  assert.equal(parseAction(echo).message, "Attention please.");
});

test("runAlertLegs: below threshold runs no legs and keeps the detection usage", async () => {
  const usage = normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 });
  const calls = [];
  const out = await runAlertLegs({
    detection: { triggered: true, confidence: 0.4, reason: "a cat" },
    threshold: 0.6,
    action: "announce it",
    webhookAction: "post it",
    usage,
    onStage: (s) => calls.push(s),
    runLeg: async (leg) => calls.push(leg),
  });
  assert.deepEqual(out, { fired: false, message: "", webhookMessage: "", usage });
  assert.deepEqual(calls, []);
});

test("runAlertLegs: fired runs announcement then webhook, in order, and sums usage", async () => {
  const calls = [];
  const out = await runAlertLegs({
    detection: { triggered: true, confidence: 0.9, reason: "a cat" },
    threshold: 0.6,
    action: "announce it",
    webhookAction: "post it",
    usage: normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 }),
    onStage: (s) => calls.push(`stage:${s}`),
    runLeg: async (leg) => {
      calls.push(`leg:${leg}`);
      return { message: `${leg} text`, usage: normalizeUsage({ prompt_tokens: 5, completion_tokens: 1 }) };
    },
  });
  assert.deepEqual(calls, ["stage:announcing", "leg:action", "stage:webhook", "leg:webhook"]);
  assert.equal(out.fired, true);
  assert.equal(out.message, "action text");
  assert.equal(out.webhookMessage, "webhook text");
  assert.equal(out.usage.prompt_tokens, 20);
  assert.equal(out.usage.completion_tokens, 4);
});

test("runAlertLegs: a blank action speaks the reason and a blank webhook action skips its leg", async () => {
  const legs = [];
  const out = await runAlertLegs({
    detection: { triggered: true, confidence: 0.9, reason: "a cat" },
    threshold: 0.6,
    action: "  ",
    webhookAction: "",
    usage: normalizeUsage({}),
    runLeg: async (leg) => legs.push(leg),
  });
  assert.deepEqual(legs, []);
  assert.equal(out.message, "a cat");
  assert.equal(out.webhookMessage, "");
});

test("scanClient: a fired alert runs detection, announcement, webhook in order and sums their usage", async () => {
  const replies = [
    '{"triggered":true,"confidence":90,"reason":"a person at the door"}',
    '{"message":"Someone is at the door."}',
    '{"message":"door: person"}',
  ];
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    const content = replies[bodies.length - 1];
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
    };
  };
  const stages = [];
  try {
    const result = await scanClient({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5vl",
      mission: "a person at the door",
      action: "Greet them.",
      webhookAction: "Summarize for the log.",
      image: "x".repeat(64),
      requestTimeout: 30,
      onStage: (s) => stages.push(s),
    });
    assert.equal(bodies.length, 3);
    assert.deepEqual(stages, ["detecting", "announcing", "webhook"]);
    assert.equal(result.triggered, true);
    assert.equal(result.message, "Someone is at the door.");
    assert.equal(result.webhookMessage, "door: person");
    assert.equal(result.usage.prompt_tokens, 300);
    assert.equal(result.usage.completion_tokens, 30);
  } finally {
    globalThis.fetch = realFetch;
  }
});
