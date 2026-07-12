// Aura demo mode — deterministic simulated scans, no camera, no API calls.
//
// Kept in its own module so removing demo mode is trivial: delete this file,
// the demo branch in useMonitor, the banner/CTA in the UI, and test/demo.test.js.
//
// Cycles through normal/alert states (fires on every third cycle with high
// confidence) so the full detect → announce loop can be tried without a key.
// Demo results NEVER carry a webhookMessage — simulated alerts must not hit
// real webhooks.

let demoScanTick = 0;

export function demoScan({ mission, action, threshold = 60 } = {}) {
  demoScanTick = (demoScanTick + 1) % 6;
  const triggered = demoScanTick % 3 === 0;
  const confidence = triggered ? 82 : 12;
  const fired = triggered && confidence >= threshold;
  const reason = triggered
    ? "A person is loitering near the entrance and repeatedly looking around."
    : "The area looks normal; nothing of concern.";
  const message = fired
    ? `(demo) ${(action || "").trim() || "Please leave the area now."}`
    : "";
  return {
    triggered: fired,
    confidence,
    reason,
    message,
    webhookMessage: "",
    mode: "demo",
    usage: {
      prompt_tokens: 560,
      completion_tokens: fired ? 40 : 18,
      total_tokens: fired ? 600 : 578,
    },
  };
}
