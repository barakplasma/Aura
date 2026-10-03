// Aura DECISION-engine model table (docs/PRD-decision-engine.md).
//
// A typed-decision model answers "does this frame satisfy the mission?" with a
// probability per option, read from one forward pass — no generated text. Each
// backend speaks its own wire dialect, and lib/decision.js holds one pure
// adapter per dialect. Adding a model is a row here, never a branch in
// decision.js: if it needs an `if (row.id === ...)`, the row is missing a
// field. (Same rule as lib/browser-models.js.)
//
// Pure data — no fetch, no DOM — so it is unit-testable under `node --test`.
//
// Every Replicate `version` pinned below must accept a request that sends
// `image_base64` only — that is the only way Aura ever sends a frame. Cog
// marks a bare `image: Path = Input(default=None)` as *required* (only
// `Optional[Path]` drops it), and Replicate then answers 422 "image is
// required" before a prediction exists — so a stale pin fails every scan and
// leaves no run to look at. After every `cog push`, run
// `REPLICATE_API_TOKEN=r8_… node scripts/replicate-pins-check.mjs`: it reads
// each pinned version's schema and fails on exactly that.

// Replicate's public hardware prices, USD per second of predict time
// (https://replicate.com/pricing, read 2026-09-26). A public model bills its
// caller for predict time only: setup, cold boots and idle cost nothing.
const REPLICATE_PER_SECOND = {
  cpu: 0.0001,
  "gpu-t4": 0.000225,
  "gpu-a100-large": 0.0014,
};

const REPLICATE_API = "https://api.replicate.com";
const CLOUDFLARE_API = "https://api.cloudflare.com";

// Who bills a hosted row, keyed by its upstream — what Settings calls the
// key field and where it says to get one. Self-hosted rows have none.
const VENDORS = {
  [REPLICATE_API]: { id: "replicate", name: "Replicate", tokenPlaceholder: "r8_…" },
  [CLOUDFLARE_API]: { id: "cloudflare", name: "Cloudflare", tokenPlaceholder: "Workers AI API token" },
};

export function vendorFor(row) {
  return VENDORS[row?.upstream] || null;
}

// The operator's BYOK CORS pass-through (homelab-manifests apps/aura-relay).
// It forwards the caller's own `Authorization` unchanged and stores nothing.
// `{path}` / `{url}` / `{url:encoded}` placeholders: see expandRelayUrl().
export const DEFAULT_RELAY_URL = "https://aura-relay.526462738.xyz{path}";

// Relays offered in Settings. Every one of them only adds CORS headers; none
// holds a credential (a stored token would bill one account for every user).
// `note` is what scripts/relay-probe.mjs found (2026-09-26) — shown in
// Settings so a preset that needs setup doesn't fail as a mystery.
export const RELAY_PRESETS = [
  { id: "operator", label: "Aura relay (default)", url: DEFAULT_RELAY_URL,
    note: "The operator's Traefik pass-through: forwards your token, stores nothing." },
  { id: "corsfix", label: "Corsfix (plain mode)", url: "https://proxy.corsfix.com/?{url}",
    note: "Answers 403 domain_not_registered until the page's origin is registered in a Corsfix account (no secrets needed)." },
  { id: "direct", label: "None — call the API directly", url: "{url}",
    note: "Only for a backend that sends CORS headers itself. Replicate does not, so a browser can't use this for it." },
];

export function relayPresetFor(url) {
  return RELAY_PRESETS.find((p) => p.url === url) || null;
}

export const DECISION_MODELS = {
  // --- Default -------------------------------------------------------------
  // Glance reads yes/no answers from the answer-token logits of a stock,
  // frozen Qwen3-VL-4B (Apache-2.0). The only typed-decision image model with
  // a hosted pay-per-run endpoint when this table was written. Community
  // owned: the version is pinned so an owner-side change can't silently
  // swap the model under Aura.
  "glance-qwen3-vl-4b": {
    label: "Glance · Qwen3-VL 4B",
    dialect: "replicate",
    upstream: REPLICATE_API,
    replicateModel: "untapped/glance-qwen3-vl-4b",
    version: "65c82d4fbfad89eaee2dabd4abd0be8703d7a3187e216edbde26eecc6f56d69f",
    hardware: "gpu-t4",
    perSecond: REPLICATE_PER_SECOND["gpu-t4"],
    // Glance's input schema has no free-text context field.
    acceptsState: false,
    calibrated: true,
    maxOptions: 20,
    note: "T4, ~1 s per decision, about $0.22 per 1,000.",
    benchmark: {
      source: "https://glance.yohei.me/speed/",
      readOn: "2026-09-26",
      summary: "0.939 yes/no accuracy zero-shot on fresh labelled photos (Glance's own set).",
    },
  },

  // Image JevBench #1: Gemma 4 12B + a 256-way decision head. The Cog
  // predictor lives in deploy/replicate/jev-omni/ and answers in Glance's
  // dialect, so this row differs from the default only in data.
  "jev-omni": {
    label: "Jev-Omni (Gemma 4 12B)",
    dialect: "replicate",
    upstream: REPLICATE_API,
    replicateModel: "barakplasma/jev-omni",
    version: "292bc2c53f4a46bec43649fb9cad4442995b370140ff357d5eea92c56a7e96bb",
    hardware: "gpu-a100-large",
    perSecond: REPLICATE_PER_SECOND["gpu-a100-large"],
    acceptsState: true,
    calibrated: true,
    maxOptions: 20,
    note: "A100 80 GB. A cold worker adds 2–3 minutes while it downloads 24 GB of weights.",
    benchmark: {
      source: "https://benchmarkheaven.com/image-jev-bench",
      readOn: "2026-09-26",
      summary: "96.8 % on the sealed everyday-photo track; 0.076 s p50 warm on a local GPU.",
    },
  },

  // Image JevBench #2, on Replicate's 8 GB CPU class
  // (deploy/replicate/small-models/predict_decider.py). Experimental until
  // Replicate smoke tests measure its latency, so never the default.
  "decider-2b-vision": {
    label: "decider-2b-vision (CPU)",
    dialect: "replicate",
    upstream: REPLICATE_API,
    replicateModel: "barakplasma/decider-2b-vision",
    version: "70846450888fa91533251c7c33d58a611d6894cd6d7d0c0f8d036f51888e2e8b",
    hardware: "cpu",
    perSecond: REPLICATE_PER_SECOND.cpu,
    acceptsState: true,
    calibrated: true,
    maxOptions: 8,
    note: "Experimental CPU port: latency on Replicate's 4 vCPU class is unmeasured.",
    benchmark: {
      source: "https://benchmarkheaven.com/image-jev-bench",
      readOn: "2026-09-26",
      summary: "89.5 % on the sealed everyday-photo track.",
    },
  },

  // A generative model, not a typed-decision one: it answers with a letter
  // and returns no probabilities (deploy/replicate/small-models/predict_qwen.py).
  // `calibrated: false` makes its confidence 100/0 from the answer, so the
  // sensitivity slider can't mean anything on it — Settings says so.
  "qwen3-vl-2b": {
    label: "Qwen3-VL 2B (CPU, uncalibrated)",
    dialect: "replicate",
    upstream: REPLICATE_API,
    replicateModel: "barakplasma/qwen3-vl-2b",
    version: "349f86184646f94dc6d7466d9a920ffd47f98d0b470435892c4b9ee9ddaa6c03",
    hardware: "cpu",
    perSecond: REPLICATE_PER_SECOND.cpu,
    acceptsState: true,
    calibrated: false,
    maxOptions: 8,
    note: "Experimental CPU port. Returns an answer only — no probabilities, so the sensitivity slider has no effect.",
    benchmark: null,
  },

  // Cloudflare's own typed-decision model (the one clef-webcam runs locally
  // as clef-flash), hosted on Workers AI and billed per input token to the
  // user's own account. Same System One answers as /v1/systemone, wrapped in
  // Cloudflare's `{ result }` envelope; the URL carries the account ID
  // (`aura.decisionAccount`), and api.cloudflare.com sends no CORS, so it
  // goes through the relay like Replicate.
  "clef": {
    label: "Clef (Cloudflare Workers AI)",
    dialect: "workers-ai",
    upstream: CLOUDFLARE_API,
    workersModel: "@cf/cloudflare/clef",
    needsAccount: true,
    perMillionInput: 0.24,
    acceptsState: true,
    calibrated: true,
    maxOptions: 20,
    note: "27B. Measured 2026-10-03: 0.7–1 s per decision, ~430 input tokens per 640×480 frame — about $0.10 per 1,000 at $0.24 per million.",
    benchmark: {
      source: "https://blog.cloudflare.com/clef-decision-models/",
      readOn: "2026-10-03",
      summary: "Cloudflare's open-weight decision model; clef-flash is its local twin.",
    },
  },

  // Self-hosted: Bonsai-Llama-Jev (a llama-server fork, pinned commit) speaks
  // TypeSafe's /v1/systemone natively with image input, CORS and API keys
  // built in, so it needs no relay — the URL is the server's own. Which GGUF
  // it serves is the operator's choice; `serverModel` is only a label the
  // server may check.
  "systemone-server": {
    label: "Self-hosted /v1/systemone (Bonsai-Llama-Jev)",
    dialect: "content",
    upstream: null,
    serverModel: "",
    defaultUrl: "http://localhost:54100",
    perSecond: 0,
    acceptsState: true,
    calibrated: true,
    maxOptions: 20,
    note: "Your own server. Start it with --cors-origins set to this page's origin.",
    benchmark: {
      source: "https://github.com/kyr0/Bonsai-Llama-Jev",
      readOn: "2026-09-26",
      summary: "Bonsai-2-27B v2 scored 97.9 % on the sealed everyday-photo track.",
    },
  },
};

export const DEFAULT_DECISION_MODEL = "glance-qwen3-vl-4b";

export function getDecisionModel(id) {
  return DECISION_MODELS[id] || null;
}

export function decisionModelKeys() {
  return Object.keys(DECISION_MODELS);
}

// A row reached through a relay (a hosted API) or called directly (the
// user's own server). Settings uses it to label the URL field and to choose
// the URL a row switch starts from.
export function usesRelay(row) {
  return Boolean(row?.upstream);
}

export function defaultDecisionUrl(row) {
  return usesRelay(row) ? DEFAULT_RELAY_URL : row?.defaultUrl || "";
}

// A Cloudflare account ID: 32 hex characters. It lands in the request path,
// so nothing else is ever let through.
export function isAccountId(value) {
  return /^[0-9a-f]{32}$/i.test(String(value || "").trim());
}

// What "configured" means for the DECISION engine: a known row, plus the
// server URL when the row is self-hosted and the account ID when its
// upstream URL needs one. Never the key — a self-hosted
// server may need none, and a missing Replicate token is a 401 with an
// actionable message, same as the PROVIDER engine.
export function isDecisionConfigured({ decisionModel, decisionUrl, decisionAccount } = {}) {
  const row = getDecisionModel(decisionModel);
  if (!row) return false;
  if (row.needsAccount && !isAccountId(decisionAccount)) return false;
  return usesRelay(row) || Boolean(String(decisionUrl || "").trim());
}
