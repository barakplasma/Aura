// Aura monitor — pure helpers for the detection/action engine.
//
// Each scan cycle runs a DETECTION call: given the operator's mission prompt and
// the current camera frame, the model decides whether the alert condition is met
// and how confident it is. If it fires (and clears the confidence threshold), an
// ACTION call generates the spoken announcement from the operator's action
// prompt. Most cycles are detection-only, so the expensive action call happens
// only on a real alert.
//
// This module holds only the prompt builders and parsers; the fetch loop lives
// in aura.js (browser) and the simulated path in demo.js.

// --- Prompts --------------------------------------------------------------

export function buildDetectionPrompt(
  mission,
  examples,
  optimizedInstruction,
  sceneHint,
) {
  const m = (mission || "").trim() || "anything unusual, unsafe, or noteworthy";
  const lines = [
    "You are an automated visual monitoring agent observing a live camera feed.",
    `Monitoring mission: "${m}"`,
  ];
  // Optional grounding from the object gate (lib/object-gate.js). Framed as a
  // hint, not a fact: the detector knows 80 COCO classes and nothing else, so
  // a small VLM must not treat its silence as evidence of absence.
  const hint = (sceneHint || "").trim();
  if (hint) {
    lines.push(
      `Scene hint (may be incomplete — trust the image over this): ${hint}`,
    );
  }
  if (optimizedInstruction) {
    lines.push(`Optimized instruction: ${optimizedInstruction}`);
  }
  lines.push(
    ...[
      "Examine the current frame and decide whether the alert condition described by",
      "the mission is TRUE right now. Judge only what is visibly happening in this",
      "frame. Be conservative — do not raise false alarms.",
    ],
  );
  if (examples && examples.length > 0) {
    const detExamples = examples
      .filter((ex) => ex.type === "detection")
      .slice(0, 5);
    if (detExamples.length > 0) {
      lines.push("Here are some examples of expected behavior:");
      for (const ex of detExamples) {
        lines.push(
          `- Scene: "${ex.sceneDescription || ""}" → triggered: ${ex.triggered}, confidence: ${ex.confidence}, reason: "${ex.reason || ""}"`,
        );
      }
    }
  }
  lines.push(
    ...[
      "Return EXACTLY a raw minified JSON object. No markdown, no commentary.",
      'Schema: {"triggered": boolean, "confidence": number, "reason": string}',
      "confidence is your certainty from 0 to 100; reason is a short factual",
      "description of what you see that justifies the decision.",
    ],
  );
  return lines.join("\n");
}

export function buildActionPrompt(
  action,
  reason,
  examples,
  optimizedInstruction,
) {
  const a =
    (action || "").trim() ||
    "Announce a clear warning about what is happening.";
  const lines = [
    "You are the announcement generator for an automated monitor.",
    "The alert condition was just met.",
    `What was detected: "${reason}"`,
    `Operator instruction for the response: "${a}"`,
  ];
  if (optimizedInstruction) {
    lines.push(`Optimized instruction: ${optimizedInstruction}`);
  }
  if (examples && examples.length > 0) {
    const actExamples = examples
      .filter((ex) => ex.type === "action")
      .slice(0, 5);
    if (actExamples.length > 0) {
      lines.push("Here are some examples of expected responses:");
      for (const ex of actExamples) {
        lines.push(
          `- Context: "${ex.context || ""}" → Message: "${ex.message || ""}"`,
        );
      }
    }
  }
  lines.push(
    ...[
      "Write the spoken announcement to broadcast aloud to the people in the scene",
      "right now, following the operator instruction. Keep it to one or two short,",
      "direct sentences. You may reference what is visible in the frame.",
      "Return EXACTLY a raw minified JSON object. No markdown.",
      'Schema: {"message": string}',
    ],
  );
  return lines.join("\n");
}

// A 256M-parameter in-browser model won't reliably emit JSON, so the BROWSER
// engine's detection call uses this much shorter, positional-answer prompt
// instead of buildDetectionPrompt()'s JSON schema. Paired with
// parseLooseDetection() below.
export function buildCompactDetectionPrompt(mission) {
  const m = (mission || "").trim() || "anything unusual, unsafe, or noteworthy";
  return [
    `Monitoring mission: "${m}"`,
    "Question: does this image satisfy the mission right now?",
    "Answer with YES or NO first, then Confidence: 0-100, then Explanation:",
    "a few words about what you can actually see.",
    "If you cannot clearly see it, answer NO.",
    "Example: NO, Confidence: 10, Explanation: books and papers on a desk,",
    "no person",
    // This field layout is the one the SmolVLM family is post-trained on for
    // document VQA, so it is the form the 500M is most likely to obey. Two
    // prose prompts were tried on the reference phone first: "Answer ... YES or
    // NO, then ..." returned the single token "YES" for every mission, and the
    // observation-first paragraph returned a caption ("Mark down the
    // information visible in the image.") that ignored the question. Naming the
    // confidence field also stops parseLooseDetection() from fabricating 100
    // for a bare verdict, which is what every alert in the device's history
    // carried. The verdict still leads: the worker scores the *first* generated
    // token as the verdict (verdictStats in lib/logprob.js), so an answer that
    // opens with the word "Answer" would measure P("Answer") instead.
  ].join("\n");
}

// The BROWSER engine's action call needs the same treatment as detection: a
// 256M model handed buildActionPrompt()'s ten-line JSON-schema prompt does not
// follow it, it paraphrases it back — "The alert condition was just met. The
// operator instruction for the response was ..." — and parseAction()'s
// prose-fallback then speaks that aloud. Short, single-instruction, no schema.
// Paired with parseCompactAction() below.
export function buildCompactActionPrompt(action, reason) {
  const a =
    (action || "").trim() ||
    "Announce a clear warning about what is happening.";
  return [
    "You are a loudspeaker at this scene. Speak to the people in the image.",
    `Say this: ${a}`,
    `You can see: ${reason || "the alert condition is met"}`,
    "Write ONE short spoken sentence and nothing else.",
    "Do not repeat these instructions. Do not use labels, quotes, or JSON.",
  ].join("\n");
}

// Same treatment for the webhook leg. buildWebhookActionPrompt() asks for a
// strict JSON object, and on the compact profile a small model answers that
// demand with what it thinks JSON looks like — the reference phone delivered
// `{"message":"{"}` to the sink four times before it was caught here. The
// caller wraps the sentence in `{"message": …}` itself, so asking the model
// for JSON on this profile buys nothing and costs the payload.
// Paired with parseCompactAction(), like the action leg above.
export function buildCompactWebhookActionPrompt(action, reason) {
  const a =
    (action || "").trim() ||
    "Describe what just happened in one sentence.";
  return [
    "You are writing one short message about a camera sighting.",
    `What was detected: ${reason || "the alert condition is met"}`,
    `The message should: ${a}`,
    "Write ONE sentence of plain text and nothing else.",
    "Do not repeat these instructions. Do not use labels, quotes, or JSON.",
  ].join("\n");
}

// Fragments of Aura's own action prompts. A reply containing one of these is
// the model echoing its instructions rather than answering them, so the line
// is dropped instead of being spoken.
const PROMPT_ECHO_MARKERS = [
  "operator instruction",
  "alert condition was just met",
  "what was detected",
  "announcement generator",
  "webhook payload generator",
  "you are a loudspeaker",
  "say this:",
  "you can see:",
  "one short spoken sentence",
  "do not repeat these instructions",
  "raw minified json",
  "no markdown",
  "schema:",
];

// Drop prompt-echo lines and leading "Message:"-style labels, and unwrap a
// fully-quoted reply. Returns "" when nothing usable is left.
export function stripPromptEcho(raw) {
  const lines = String(raw ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const low = line.toLowerCase();
      return !PROMPT_ECHO_MARKERS.some((marker) => low.includes(marker));
    });
  let text = lines[0] || "";
  text = text.replace(/^(?:message|announcement|answer|response|output)\s*[:\-]\s*/i, "");
  text = text.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "");
  return text.trim();
}

// Parser for buildCompactActionPrompt(): first usable line, prompt echoes
// removed. `fallback` (normally the detection reason) is used when the model
// returned nothing but echo.
export function parseCompactAction(raw, fallback) {
  const text = stripPromptEcho(raw);
  if (text) return { message: text.slice(0, 300) };
  const fb = String(fallback ?? "").trim();
  return { message: fb ? fb.slice(0, 300) : "Attention please." };
}

export function buildWebhookActionPrompt(action, reason, schema) {
  const a = (action || "").trim() || "Describe what just happened in detail.";
  const lines = [
    "You are the webhook payload generator for an automated monitor.",
    "The alert condition was just met.",
    `What was detected: "${reason}"`,
    `Operator instruction for the webhook payload: "${a}"`,
    "Generate a strict JSON payload to send to an external webhook.",
  ];
  if (schema && typeof schema === "object") {
    lines.push("You MUST follow this JSON Schema exactly:");
    lines.push(JSON.stringify(schema, null, 2));
    lines.push(
      "Do not add or omit any properties. Output only the JSON object.",
    );
  } else {
    lines.push("Include whatever information the operator requested.");
  }
  lines.push("Return EXACTLY a raw minified JSON object. No markdown.");
  lines.push('Schema: {"message": string}');
  return lines.join("\n");
}

// --- Parsing / validation -------------------------------------------------

export function isolateJsonObject(raw) {
  if (raw == null) throw new Error("Empty model response.");
  let text = stripThinkBlocks(String(raw)).trim();
  text = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`No JSON object in response: ${text.slice(0, 120)}`);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

// Thinking-mode replies wrap reasoning in <think>…</think> before the answer,
// and that reasoning can contain braces that would break isolateJsonObject()'s
// first-{…last-} slice, or a YES line that isn't the answer. An unterminated
// block (generation truncated mid-think) means nothing after it is an answer.
function stripThinkBlocks(text) {
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "");
}

export function parseDetection(raw) {
  return normalizeDetection(isolateJsonObject(raw));
}

export function normalizeDetection(obj) {
  if (typeof obj !== "object" || obj === null)
    throw new Error("Response is not an object.");
  const triggered = truthyFlag(obj.triggered);
  const confidence = clamp(
    confidencePercent(obj.confidence, triggered ? 100 : 0),
    0,
    100,
  );
  let reason = String(obj.reason ?? "")
    .trim()
    .slice(0, 240);
  if (!reason)
    reason = triggered ? "Alert condition met." : "Nothing notable in view.";
  return { triggered, confidence, reason };
}

// Small models emit booleans as strings ("true"/"false"/"yes"/"no"), and
// plain Boolean coercion makes any non-empty string true — flipping
// {"triggered":"false"} into a fired alert. Read the wording when it's a
// string; anything else keeps the plain coercion.
function truthyFlag(v) {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "false" || s === "no" || s === "0") return false;
    if (s === "true" || s === "yes" || s === "1") return true;
  }
  return Boolean(v);
}

// The detection schema asks for 0-100, but small models sometimes answer on a
// 0-1 scale. A value strictly between 0 and 1 can only be a fraction (nobody
// answers "0.91% certainty" here), so scale it up; exactly 0 and 1 keep their
// percent meaning. Unparseable input falls back to the triggered default.
function confidencePercent(v, fallback) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (!Number.isFinite(n)) return fallback;
  return n > 0 && n < 1 ? Math.round(n * 100) : n;
}

export function parseAction(raw) {
  let obj;
  try {
    obj = isolateJsonObject(raw);
  } catch {
    // No JSON object in the reply — a prose-only reply is still useful
    // (small in-browser models rarely emit JSON), so use it verbatim rather
    // than falling all the way through to the generic fallback below. Only
    // an empty reply gets the generic message.
    const text = stripPromptEcho(raw);
    return { message: text ? text.slice(0, 300) : "Attention please." };
  }
  let message = String(obj.message ?? "")
    .trim()
    .slice(0, 300);
  if (!message) message = "Attention please.";
  return { message };
}

// Accepts either the strict JSON detection schema (via isolateJsonObject) or a
// small model's loose answer — "YES 80 someone at the door", or, with the
// observation-first prompt, "books on a desk NO 10". Never throws: unparseable
// input degrades to a conservative, non-triggered result.
export function parseLooseDetection(raw) {
  try {
    return normalizeDetection(isolateJsonObject(raw));
  } catch {
    // Fall through to loose parsing below.
  }
  const text = stripThinkBlocks(String(raw ?? "")).trim();
  // Labelled fields beat guessing. The compact prompt asks for
  // `NO, Confidence: 10, Explanation: …` — the labelled Confidence is worth
  // more than a number located by position (without this branch, "YES,
  // Confidence: 20" has no digit next to YES, so confidence would default to
  // 100 and "Confidence: 20, Explanation: …" would be spoken as the reason) —
  // and an `Answer:`-labelled verdict beats a verdict found by scan. Both
  // lookaheads reject the prompt's own placeholders ("YES or NO") being echoed
  // back as if they were the answer.
  const conf = /\bconfidence\s*[:=]\s*([0-9]{1,3})\s*%?/i.exec(text);
  const labelled = /\banswer\s*[:=]\s*(yes|no)\b(?!\s+or\s)/i.exec(text);
  if (conf || labelled) {
    const why = /\b(?:explanation|seen|because|reason)\s*[:=]\s*([^\n]+)/i.exec(text);
    const loose = /\b(yes|no)\b(?!\s+or\s+no\b)/i.exec(text);
    const word = labelled?.[1] ?? loose?.[1] ?? null;
    const triggered = /^yes$/i.test(String(word || ""));
    const reason = String(why?.[1] || "").replace(/^[\s,:;.\-]+/, "").trim();
    return {
      triggered,
      confidence: clamp(
        confidencePercent(toNumber(conf?.[1], NaN), triggered ? 100 : 0),
        0,
        100,
      ),
      reason:
        reason.slice(0, 240) ||
        (triggered ? "Alert condition met." : "Nothing notable in view."),
    };
  }

  // The verdict no longer has to head the line: a model asked to describe
  // first puts it at the end, and on more than one line. Prefer a verdict
  // followed by a confidence number, because that is where an answer is — a
  // trailing "no" inside a reason ("no one else in frame") is not the verdict.
  // With no number anywhere, take the first verdict, which is where a model
  // that skips the number puts it.
  const verdicts = [...text.matchAll(/\b(yes|no)\b/gi)];
  if (!verdicts.length) {
    return { triggered: false, confidence: 0, reason: "Nothing notable in view." };
  }
  const tail = (v) => text.slice(v.index + v[0].length);
  const numbered = verdicts.filter((v) => /^[\s,:;.\-]*[0-9]{1,3}\s*%?/.test(tail(v)));
  const pick = numbered.at(-1) || verdicts[0];
  const triggered = /^yes$/i.test(pick[0]);
  const after = tail(pick);
  const num = /^[\s,:;.\-]*([0-9]{1,3})\s*%?([\s\S]*)$/.exec(after);
  const confidence = clamp(toNumber(num?.[1], triggered ? 100 : 0), 0, 100);
  const rest = (num?.[2] ?? after).replace(/^[\s,:;.\-]+/, "").trim();
  const before = text.slice(0, pick.index).replace(/[\s,:;.\-]+$/, "").trim();
  const reason = (rest || before).slice(0, 240) ||
    (triggered ? "Alert condition met." : "Nothing notable in view.");
  return { triggered, confidence, reason };
}

export function parseWebhookAction(raw) {
  const obj = isolateJsonObject(raw);
  let message = String(obj.message ?? "")
    .trim()
    .slice(0, 1000);
  if (!message) message = "Alert triggered.";
  return { message };
}

export function normalizeUsage(u) {
  const valid = (v) => Number.isFinite(v) && v >= 0;
  const reported = valid(u?.prompt_tokens) || valid(u?.completion_tokens) || valid(u?.total_tokens);
  const n = (v) => (valid(v) ? v : 0);
  const prompt = n(u?.prompt_tokens);
  const completion = n(u?.completion_tokens);
  const total = n(u?.total_tokens) || prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    reported,
  };
}

// Sum two usage records — detection + action + webhook calls within one scan.
// `partial` marks a session whose numbers mix reported and unreported sources.
// Lives here rather than duplicated per engine (aura.js and browser-engine.js
// both accumulate usage the same way).
export function sumUsage(a, b) {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    reported: a.reported || b.reported,
    partial: Boolean(a.partial || b.partial || a.reported !== b.reported),
  };
}

// Everything after the detection call: decide whether the alert fired, then
// run the announcement leg and the webhook leg. Both engines share this flow
// and differ only in how a leg is generated — `runLeg("action" | "webhook")`
// resolves to { message, usage } with usage already normalized.
export async function runAlertLegs({ detection, threshold, action, webhookAction, usage, onStage, runLeg }) {
  const fired = detection.triggered && detection.confidence >= threshold;
  let message = "";
  let webhookMessage = "";
  if (fired) {
    if ((action || "").trim()) {
      onStage?.("announcing");
      const act = await runLeg("action");
      message = act.message;
      usage = sumUsage(usage, act.usage);
    } else {
      message = detection.reason;
    }

    if ((webhookAction || "").trim()) {
      onStage?.("webhook");
      const wh = await runLeg("webhook");
      webhookMessage = wh.message;
      usage = sumUsage(usage, wh.usage);
    }
  }
  return { fired, message, webhookMessage, usage };
}

// True for a provider running on this machine or LAN (Ollama, LM Studio,
// llama.cpp). Such servers normally need no API key, and their failure modes
// are different enough — server not started, CORS not opened — to be worth a
// tailored error message.
export function isLocalBaseUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // hostname keeps the brackets around an IPv6 literal.
  if (host === "localhost" || host === "0.0.0.0") return true;
  if (host === "[::1]" || host === "::1") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  // 127.0.0.0/8, 10.0.0.0/8, 192.168.0.0/16, 172.16.0.0/12
  if (/^127\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(host);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

// Whether two base URLs point at the same origin (scheme + host + port).
// Used to decide when switching providers has to drop the stored API key —
// unparseable input returns false, so a half-typed URL can never read as a
// match and skip the clear.
export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

// --- utils ----------------------------------------------------------------

function toNumber(v, fallback) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
