// Aura CHROME BUILT-IN AI runtime — an optional in-browser transport backed
// by Chrome's Prompt API (Gemini Nano), fully separate from Transformers.js.
//
// It is deliberately a *transport*, not a second scan engine: the only thing
// it exposes is "prompt + frame list → text", the same call the ML worker
// answers. Every engine concern (which prompt, which parser, thresholds, the
// fired/action assembly) stays in lib/browser-engine.js, and the API's churn
// — this surface is still stabilizing — stays inside this file.
//
// Facts this module is written against (developer.chrome.com/docs/ai/prompt-api,
// verified 2026-09):
//   - Global `LanguageModel`; shipped to the web in Chrome 148 (extensions
//     since 138). Feature-detect it; never user-agent sniff.
//   - `LanguageModel.availability()` → 'unavailable' | 'downloadable' |
//     'downloading' | 'available'. Creating a session while 'downloadable'
//     starts a ~2 GB model download — so eligibility probing must only
//     create() when availability is exactly 'available'.
//   - Image input needs `expectedInputs` to include { type: "image" } at
//     create() time; on builds without multimodal input that create()
//     rejects, which IS the capability probe (no user-agent sniffing).
//   - Frames are passed as content parts — Blob, ImageBitmap, canvas, ….
//     Aura's JPEG data URLs are converted to Blobs here.
//   - `responseConstraint` takes a JSON Schema and constrains decoding to it:
//     the only genuinely structured output available in-browser.
//   - Not available in workers (main thread only), and NOT on Chrome for
//     Android — on Aura's reference phone this whole module feature-detects
//     to absent and Auto falls back to Transformers.js.
//
// Sessions are stateful (prompt() appends to a conversation), and a monitor
// needs every scan independent of the last, so a bare "root" session is kept
// alive and each call runs on a fresh clone() that is destroyed afterwards —
// stateless per scan, no model reload between scans.

// Test seam: `new LanguageModel()` can't run under node --test, so tests
// inject a stand-in via _setLanguageModelFactory(), mirroring
// _setWorkerFactory() in browser-engine.js.
let languageModelFactory = () =>
  typeof LanguageModel !== "undefined" ? LanguageModel : null;

export function _setLanguageModelFactory(factory) {
  languageModelFactory = factory || (() => null);
}

// Root session + probed capability state, all reset by _resetChromeAI().
let rootSession = null;
let probedImageCapable = null; // null = not probed yet
let constraintUnsupported = false; // this build rejected responseConstraint

export function _resetChromeAI() {
  languageModelFactory = () =>
    typeof LanguageModel !== "undefined" ? LanguageModel : null;
  destroyRootSession();
  probedImageCapable = null;
  constraintUnsupported = false;
}

function destroyRootSession() {
  if (rootSession) {
    try {
      rootSession.destroy();
    } catch {
      // The session may already be gone (page teardown); nothing to do.
    }
  }
  rootSession = null;
}

const CREATE_OPTIONS = {
  expectedInputs: [{ type: "text" }, { type: "image" }],
  expectedOutputs: [{ type: "text" }],
};

/**
 * What can this browser's built-in AI do right now? Never throws.
 *
 * `imageCapable` is the expensive half (it costs one create() against the
 * already-downloaded model), so it is probed once and cached; `availability`
 * is re-read every call because the model can finish downloading later.
 * Availability other than 'available' reports imageCapable: false without
 * probing — creating a session while 'downloadable' would silently start a
 * ~2 GB download, which a capability probe must never do.
 */
export async function probeChromeAI() {
  let impl = null;
  try {
    impl = languageModelFactory();
  } catch {
    impl = null;
  }
  if (!impl) return { present: false, availability: "absent", imageCapable: false };

  let availability = "unknown";
  try {
    if (typeof impl.availability === "function") {
      availability = String(await impl.availability());
    }
  } catch {
    availability = "unknown";
  }

  if (probedImageCapable !== null) {
    return { present: true, availability, imageCapable: probedImageCapable };
  }
  if (availability !== "available") {
    return { present: true, availability, imageCapable: false };
  }

  // The capability probe IS a create() with image input expected: builds
  // without multimodal input reject it. A success is kept as the root
  // session, so probing costs nothing beyond the first scan anyway.
  try {
    rootSession = await impl.create(CREATE_OPTIONS);
    probedImageCapable = true;
  } catch {
    rootSession = null;
    probedImageCapable = false;
  }
  return { present: true, availability, imageCapable: probedImageCapable };
}

async function getRootSession() {
  if (rootSession) return rootSession;
  const impl = languageModelFactory();
  if (!impl) {
    throw new Error(
      "Chrome built-in AI is not available in this browser. Switch the runtime to Transformers.js.",
    );
  }
  try {
    rootSession = await impl.create(CREATE_OPTIONS);
  } catch (err) {
    rootSession = null;
    throw new Error(
      `Chrome built-in AI could not create a session (${err?.message || err}). Vision detection needs image input, which this build may not support — switch the runtime to Transformers.js.`,
    );
  }
  return rootSession;
}

/**
 * One inference: prompt + frames → text. The exact call shape the ML worker's
 * 'scan' handler answers, so browser-engine.js can route either way.
 *
 * `schema`, when given, constrains decoding via responseConstraint; a build
 * that rejects it is remembered for the session and the call retries without
 * (the engine's parsers degrade gracefully — same contract as provider JSON
 * mode in lib/aura.js).
 *
 * Gemini Nano exposes no token counts, so usage is reported:false zeros —
 * the same "free, uncounted" treatment BROWSER-engine scans get.
 */
export async function scanChromeAICall({
  prompt,
  imageDataUrls,
  schema,
  signal,
} = {}) {
  const root = await getRootSession();
  if (signal?.aborted) throw toAbortError(signal.reason);

  // Fresh conversation per scan; the root stays alive for the next one.
  const session = await root.clone();
  try {
    const parts = [{ type: "text", value: prompt }];
    for (const url of imageDataUrls || []) {
      // Blob, per the Prompt API's accepted image types; fetch() of a data:
      // URL decodes the base64 without a canvas round-trip.
      parts.push({ type: "image", value: await (await fetch(url)).blob() });
    }
    const content = [{ role: "user", content: parts }];
    let text;
    try {
      text = await session.prompt(content, {
        ...(schema && !constraintUnsupported ? { responseConstraint: schema } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (schema && !constraintUnsupported && isConstraintRejection(err)) {
        constraintUnsupported = true;
        text = await session.prompt(content, signal ? { signal } : {});
      } else {
        throw err;
      }
    }
    return {
      text: String(text ?? "").trim(),
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reported: false },
    };
  } finally {
    try {
      session.destroy();
    } catch {
      // Clone cleanup is best-effort; the scan result matters more.
    }
  }
}

// Whether a failed prompt() is objecting to responseConstraint itself rather
// than to the prompt — same shape of check as rejectsJsonMode() in aura.js.
function isConstraintRejection(err) {
  return (
    err instanceof TypeError ||
    /responseConstraint|constraint/i.test(String(err?.message || ""))
  );
}

function toAbortError(reason) {
  if (reason instanceof Error) return reason;
  return new DOMException("Aborted", "AbortError");
}
