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

export function buildDetectionPrompt(mission, examples, optimizedInstruction) {
  const m = (mission || "").trim() || "anything unusual, unsafe, or noteworthy";
  const lines = [
    "You are an automated visual monitoring agent observing a live camera feed.",
    `Monitoring mission: "${m}"`,
  ];
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
  let text = String(raw).trim();
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

export function parseDetection(raw) {
  return normalizeDetection(isolateJsonObject(raw));
}

export function normalizeDetection(obj) {
  if (typeof obj !== "object" || obj === null)
    throw new Error("Response is not an object.");
  const triggered = Boolean(obj.triggered);
  const confidence = clamp(
    toNumber(obj.confidence, triggered ? 100 : 0),
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

export function parseAction(raw) {
  const obj = isolateJsonObject(raw);
  let message = String(obj.message ?? "")
    .trim()
    .slice(0, 300);
  if (!message) message = "Attention please.";
  return { message };
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
  const n = (v) => (Number.isFinite(v) ? v : 0);
  const prompt = n(u?.prompt_tokens);
  const completion = n(u?.completion_tokens);
  const total = n(u?.total_tokens) || prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  };
}

// --- utils ----------------------------------------------------------------

function toNumber(v, fallback) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : fallback;
}
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
