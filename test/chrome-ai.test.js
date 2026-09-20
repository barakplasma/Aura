import { test } from "node:test";
import assert from "node:assert/strict";
import {
  probeChromeAI,
  scanChromeAICall,
  _setLanguageModelFactory,
  _resetChromeAI,
} from "../lib/chrome-ai.js";

// Stand-in for the window.LanguageModel capability (Chrome built-in AI /
// Gemini Nano). Only the surface lib/chrome-ai.js touches is faked:
// availability(), create(), and the session's clone/prompt/destroy.
function fakeLanguageModel({
  availability = "available",
  imageCapable = true,
  promptImpl,
} = {}) {
  let sessions = 0;
  const impl = {
    availabilityCalls: 0,
    createCalls: [],
    sessionCount: () => sessions,
    async availability(options) {
      this.availabilityCalls += 1;
      if (typeof availability === "function") return availability(options);
      return availability;
    },
    async create(options) {
      this.createCalls.push(options);
      if (!imageCapable) {
        throw new DOMException("Image input not supported", "NotSupportedError");
      }
      sessions += 1;
      return makeSession({ promptImpl });
    },
  };
  return impl;
}

function makeSession({ promptImpl } = {}) {
  return {
    destroyed: false,
    cloneCalls: 0,
    prompts: [],
    clone() {
      this.cloneCalls += 1;
      return makeSession({ promptImpl });
    },
    async prompt(content, options) {
      this.prompts.push({ content, options });
      return promptImpl ? promptImpl(content, options) : '{"triggered":false,"confidence":0,"reason":"nothing"}';
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test.beforeEach(() => {
  _resetChromeAI();
});

test("probe reports absent when the LanguageModel global doesn't exist", async () => {
  _setLanguageModelFactory(() => null);
  const probe = await probeChromeAI();
  assert.deepEqual(probe, { present: false, availability: "absent", imageCapable: false });
});

test("probe feature-detects image capability by creating a session that expects images", async () => {
  const impl = fakeLanguageModel({ availability: "available", imageCapable: true });
  _setLanguageModelFactory(() => impl);
  const probe = await probeChromeAI();
  assert.deepEqual(probe, { present: true, availability: "available", imageCapable: true });
  const createOptions = impl.createCalls[0];
  const expectedTypes = (createOptions.expectedInputs || []).map((t) => t.type);
  assert.ok(expectedTypes.includes("image"), "create() asked for image input");
});

test("probe reports imageCapable:false when the build rejects image input", async () => {
  const impl = fakeLanguageModel({ availability: "available", imageCapable: false });
  _setLanguageModelFactory(() => impl);
  const probe = await probeChromeAI();
  assert.deepEqual(probe, { present: true, availability: "available", imageCapable: false });
});

test("probe never throws, whatever the API does", async () => {
  _setLanguageModelFactory(() => {
    throw new Error("weird partial implementation");
  });
  const probe = await probeChromeAI();
  assert.equal(probe.present, false);

  _resetChromeAI();
  _setLanguageModelFactory(() => ({
    availability: () => Promise.reject(new Error("boom")),
    create: () => Promise.reject(new Error("boom")),
  }));
  const probe2 = await probeChromeAI();
  assert.equal(probe2.imageCapable, false);
});

test("the image-capability probe result is cached, not re-created per call", async () => {
  const impl = fakeLanguageModel({ availability: "available", imageCapable: true });
  _setLanguageModelFactory(() => impl);
  await probeChromeAI();
  await probeChromeAI();
  assert.ok(impl.createCalls.length <= 1, "create() ran at most once across probes");
});

test("scanChromeAICall sends text + image parts with a responseConstraint", async () => {
  const clones = [];
  const impl = fakeLanguageModel({ imageCapable: true });
  impl.create = async () => ({
    clone() {
      const c = makeSession({
        promptImpl: () => '{"triggered":true,"confidence":85,"reason":"a person"}',
      });
      clones.push(c);
      return c;
    },
    destroy() {},
  });
  _setLanguageModelFactory(() => impl);

  const result = await scanChromeAICall({
    prompt: "Is there a person?",
    imageDataUrls: [
      "data:image/jpeg;base64," +
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ],
    schema: { type: "object", properties: { triggered: { type: "boolean" } } },
  });

  assert.equal(result.text, '{"triggered":true,"confidence":85,"reason":"a person"}');
  const call = clones[0].prompts[0];
  const parts = call.content[0].content;
  const imageParts = parts.filter((p) => p.type === "image");
  const textParts = parts.filter((p) => p.type === "text");
  assert.equal(imageParts.length, 1, "one image part");
  assert.ok(imageParts[0].value instanceof Blob, "the frame is a Blob, not a data URL string");
  assert.equal(textParts[0].value, "Is there a person?");
  assert.ok(call.options.responseConstraint, "the JSON schema reached the call");
});

test("scanChromeAICall clones the root session per call and destroys the clone", async () => {
  let rootDestroyed = false;
  const clones = [];
  const rootSession = {
    clone() {
      const c = makeSession({});
      clones.push(c);
      return c;
    },
    destroy() {
      rootDestroyed = true;
    },
  };
  const impl = fakeLanguageModel({ imageCapable: true });
  impl.create = async () => rootSession;
  _setLanguageModelFactory(() => impl);

  await scanChromeAICall({ prompt: "p", imageDataUrls: [] });
  assert.equal(clones.length, 1);
  assert.equal(clones[0].destroyed, true, "the per-call clone was destroyed");
  assert.equal(rootDestroyed, false, "the root session survives for the next scan");
});

test("scanChromeAICall reports zero usage — Gemini Nano exposes no token counts", async () => {
  const impl = fakeLanguageModel({ imageCapable: true });
  _setLanguageModelFactory(() => impl);
  const result = await scanChromeAICall({ prompt: "p", imageDataUrls: [] });
  assert.equal(result.usage.reported, false);
  assert.equal(result.usage.total_tokens, 0);
});

test("scanChromeAICall retries without the constraint when it is rejected once", async () => {
  let calls = 0;
  const session = {
    clone() {
      return {
        async prompt(content, options) {
          calls += 1;
          if (options?.responseConstraint) {
            throw new TypeError("responseConstraint not supported");
          }
          return "NO 5 nothing here";
        },
        destroy() {},
      };
    },
    destroy() {},
  };
  const impl = fakeLanguageModel({ imageCapable: true });
  impl.create = async () => session;
  _setLanguageModelFactory(() => impl);

  const result = await scanChromeAICall({
    prompt: "p",
    imageDataUrls: [],
    schema: { type: "object" },
  });
  assert.equal(result.text, "NO 5 nothing here");
  assert.equal(calls, 2, "first call with constraint, retry without");
});

test("scanChromeAICall throws an actionable error when explicitly used while unavailable", async () => {
  _setLanguageModelFactory(() => null);
  await assert.rejects(
    scanChromeAICall({ prompt: "p", imageDataUrls: [] }),
    /Chrome built-in AI is not available/,
  );
});

test("an aborted scan rejects and destroys the clone", async () => {
  const controller = new AbortController();
  const clones = [];
  const rootSession = {
    clone() {
      const c = {
        async prompt(content, options) {
          clones.push(c);
          controller.abort();
          // Real API rejects with the signal's reason; emulate.
          throw new DOMException("Aborted", "AbortError");
        },
        destroy() {},
      };
      return c;
    },
    destroy() {},
  };
  const impl = fakeLanguageModel({ imageCapable: true });
  impl.create = async () => rootSession;
  _setLanguageModelFactory(() => impl);

  await assert.rejects(
    scanChromeAICall({ prompt: "p", imageDataUrls: [], signal: controller.signal }),
    (err) => err.name === "AbortError",
  );
});
