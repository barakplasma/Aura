// Unit tests for the e2e harness's decision core (e2e/policy.mjs): which
// OpenAI-compatible endpoint a leg targets, and whether a scan result
// actually passes its expectation. The runner (e2e.mjs) is orchestration and
// is exercised live; this module is the part with judgment in it, so it is
// the part under unit test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickProviderTarget, judgeScan } from "../e2e/policy.mjs";

test("explicit E2E_BASE_URL + E2E_MODEL wins over every ambient key", () => {
  const target = pickProviderTarget({
    E2E_BASE_URL: "http://localhost:8080/v1",
    E2E_MODEL: "qwen2.5vl:3b",
    E2E_API_KEY: "",
    OPENROUTER_API_KEY: "sk-or",
  });
  assert.deepEqual(target, {
    baseUrl: "http://localhost:8080/v1",
    model: "qwen2.5vl:3b",
    apiKey: "",
    label: "custom",
  });
});

test("E2E_BASE_URL without E2E_MODEL is an actionable error", () => {
  assert.throws(
    () => pickProviderTarget({ E2E_BASE_URL: "http://localhost:8080/v1" }),
    /E2E_MODEL/,
  );
});

test("no explicit URL: first ambient key wins, in a fixed order", () => {
  const or = pickProviderTarget({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "k2" });
  assert.equal(or.label, "openrouter");
  assert.equal(or.baseUrl, "https://openrouter.ai/api/v1");

  const oa = pickProviderTarget({ OPENAI_API_KEY: "k2", GEMINI_API_KEY: "k3" });
  assert.equal(oa.label, "openai");
  assert.equal(oa.baseUrl, "https://api.openai.com/v1");

  const gem = pickProviderTarget({ GEMINI_API_KEY: "k3" });
  assert.equal(gem.label, "gemini");
  assert.equal(gem.baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
});

test("E2E_MODEL overrides the ambient provider's default model", () => {
  const t = pickProviderTarget({
    OPENAI_API_KEY: "k",
    E2E_MODEL: "gpt-5-mini",
  });
  assert.equal(t.model, "gpt-5-mini");
  assert.equal(t.label, "openai");
});

test("no usable configuration names what is missing", () => {
  assert.throws(() => pickProviderTarget({}), /E2E_BASE_URL.*or.*API key|key/i);
});

test("judgeScan: a matching non-trigger with sane shape passes", () => {
  const verdict = judgeScan(
    {
      triggered: false,
      confidence: 4,
      reason: "",
      message: "",
      latencyMs: 812,
      usage: { total_tokens: 320 },
      mode: "live",
    },
    { expectedTriggered: false, expectedMode: "live" },
  );
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.pass, true);
});

test("judgeScan: a matching trigger demands a non-empty alert message", () => {
  const good = judgeScan(
    {
      triggered: true,
      confidence: 93,
      reason: "a person is standing in the doorway",
      message: "Visitor at the front door.",
      latencyMs: 1200,
      usage: { total_tokens: 500 },
      mode: "live",
    },
    { expectedTriggered: true, expectedMode: "live" },
  );
  assert.equal(good.pass, true);

  const mute = judgeScan(
    {
      triggered: true,
      confidence: 93,
      reason: "a person is standing in the doorway",
      message: "",
      latencyMs: 1200,
      usage: { total_tokens: 500 },
      mode: "live",
    },
    { expectedTriggered: true, expectedMode: "live" },
  );
  assert.equal(mute.pass, false);
  assert.ok(mute.failures.some((f) => /message/i.test(f)));
});

test("judgeScan: a misfire fails with the reason named", () => {
  const verdict = judgeScan(
    { triggered: true, confidence: 80, reason: "x", message: "y", latencyMs: 1, usage: { total_tokens: 5 }, mode: "live" },
    { expectedTriggered: false, expectedMode: "live" },
  );
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failures.some((f) => /triggered/i.test(f)));
});

test("judgeScan: broken shape fails — confidence out of range, no usage, bad mode", () => {
  const verdict = judgeScan(
    { triggered: false, confidence: 140, reason: "", message: "", latencyMs: -3, usage: null, mode: "browser" },
    { expectedTriggered: false, expectedMode: "live" },
  );
  assert.equal(verdict.pass, false);
  assert.ok(verdict.failures.some((f) => /confidence/i.test(f)));
  assert.ok(verdict.failures.some((f) => /usage/i.test(f)));
  assert.ok(verdict.failures.some((f) => /mode/i.test(f)));
});
