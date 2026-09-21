import test from "node:test";
import assert from "node:assert/strict";
import { costForUsage, pricingKey, resolvePricing } from "../lib/pricing.js";

test("pricing keys are stable across URL trailing slashes and case", () => {
  assert.equal(pricingKey("https://API.example/v1/", "GPT-4O-MINI"), pricingKey("https://api.example/v1", "gpt-4o-mini"));
});

test("manual price overrides take precedence and price input/output separately", () => {
  const pricing = resolvePricing({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    override: { inputRate: "2", outputRate: "5" },
  });
  assert.equal(pricing.source, "manual");
  assert.equal(costForUsage({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, pricing), 7);
});

test("OpenRouter exact catalogue records are primary", () => {
  const pricing = resolvePricing({
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash",
  });
  assert.equal(pricing.source, "openrouter");
  assert.equal(pricing.inputRate, 0.3);
  assert.equal(pricing.outputRate, 2.5);
});

test("local and browser engines are free", () => {
  assert.equal(resolvePricing({ baseUrl: "http://localhost:11434/v1", model: "x" }).inputRate, 0);
  assert.equal(resolvePricing({ engine: "browser", model: "x" }).outputRate, 0);
});
