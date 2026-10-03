import { vendorFor } from "./decision-models.js";
import { isLocalBaseUrl } from "./monitor.js";
import { PRICING_SNAPSHOT } from "./pricing-snapshot.js";

const ALIASES = new Map([
  ["pixtral-12b-2409", "pixtral-12b"],
]);
const PRICES_BY_ID = new Map();
const PRICES_BY_TAIL = new Map();
for (const price of PRICING_SNAPSHOT.prices) {
  PRICES_BY_ID.set(`${price.source}\u0000${price.id}`, price);
  const key = `${price.source}\u0000${price.id.split("/").at(-1)}`;
  const matches = PRICES_BY_TAIL.get(key) || [];
  matches.push(price);
  PRICES_BY_TAIL.set(key, matches);
}

export function pricingKey(baseUrl, model) {
  return `${String(baseUrl || "").replace(/\/+$/, "").toLowerCase()}\u0000${String(model || "").toLowerCase()}`;
}

function normalizedModelId(model) {
  const raw = String(model || "").trim().toLowerCase();
  return ALIASES.get(raw) || raw;
}

function isOpenRouter(baseUrl) {
  try {
    return new URL(baseUrl).hostname === "openrouter.ai";
  } catch {
    return false;
  }
}

function sourceMatch(source, model) {
  const id = normalizedModelId(model);
  const exact = PRICES_BY_ID.get(`${source}\u0000${id}`);
  if (exact) return exact;
  // Upstream records often omit the routing-provider prefix. Only use this
  // looser match when it resolves to exactly one record.
  const tail = id.split("/").at(-1);
  const matches = PRICES_BY_TAIL.get(`${source}\u0000${tail}`) || [];
  return matches.length === 1 ? matches[0] : null;
}

export function resolvePricing({ baseUrl, model, engine = "provider", override } = {}) {
  if (engine === "browser" || isLocalBaseUrl(baseUrl)) {
    return { inputRate: 0, outputRate: 0, source: "free", estimated: false, updatedAt: null };
  }
  const hasManualRates = override && [override.inputRate, override.outputRate].every(
    (value) => String(value ?? "").trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0,
  );
  if (hasManualRates) {
    return {
      inputRate: Number(override.inputRate),
      outputRate: Number(override.outputRate),
      source: "manual",
      estimated: false,
      updatedAt: null,
    };
  }
  // OpenRouter is the primary catalogue. Its exact routing price is preferred
  // for the OpenRouter provider; its records also win for a matching full ID.
  const openRouter = sourceMatch("openrouter", model);
  const fallback = sourceMatch("llm-prices", model);
  const price = (isOpenRouter(baseUrl) && openRouter) || openRouter || fallback;
  if (!price) return { inputRate: null, outputRate: null, source: "unavailable", estimated: false, updatedAt: null };
  return {
    inputRate: price.inputRate,
    outputRate: price.outputRate,
    source: price.source,
    estimated: price.source !== "openrouter",
    updatedAt: PRICING_SNAPSHOT.sources[price.source]?.updatedAt || null,
  };
}

// Token cost plus, for the DECISION engine, predict-time cost: Replicate bills
// a public model per second of predict time (`perSecond`); a flat
// `perDecision` rate covers backends that report no timing, and Workers AI
// bills the decision model's own input tokens (`perMillionInput`, counted
// apart from the announcer's tokens as `decision_tokens`). Null only when
// no rate at all is known.
export function costForUsage(usage, pricing) {
  const input = Number(usage?.prompt_tokens) || 0;
  const output = Number(usage?.completion_tokens) || 0;
  const inputRate = Number(pricing?.inputRate);
  const outputRate = Number(pricing?.outputRate);
  const perSecond = Number(pricing?.perSecond);
  const perDecision = Number(pricing?.perDecision);
  const perMillionInput = Number(pricing?.perMillionInput);
  const tokenRated = Number.isFinite(inputRate) && Number.isFinite(outputRate);
  const decisionRated = Number.isFinite(perSecond) || Number.isFinite(perDecision) || Number.isFinite(perMillionInput);
  if (!tokenRated && !decisionRated) return null;
  let cost = tokenRated ? (input * inputRate + output * outputRate) / 1e6 : 0;
  if (Number.isFinite(perSecond)) cost += (Number(usage?.predict_s) || 0) * perSecond;
  if (Number.isFinite(perDecision)) cost += (Number(usage?.decisions) || 0) * perDecision;
  if (Number.isFinite(perMillionInput)) cost += ((Number(usage?.decision_tokens) || 0) * perMillionInput) / 1e6;
  return cost;
}

// DECISION pricing: the decision model's own rate from its row, plus the
// provider's token rates when a provider announces (or is the fallback).
// A self-hosted row is free.
export function resolveDecisionPricing({ row, providerPricing } = {}) {
  const tokens = providerPricing && Number.isFinite(Number(providerPricing.inputRate))
    ? { inputRate: providerPricing.inputRate, outputRate: providerPricing.outputRate }
    : { inputRate: null, outputRate: null };
  return {
    ...tokens,
    perSecond: Number.isFinite(row?.perSecond) ? row.perSecond : null,
    perMillionInput: Number.isFinite(row?.perMillionInput) ? row.perMillionInput : null,
    source: vendorFor(row)?.id || "free",
    estimated: true,
    updatedAt: null,
  };
}
