import { test } from "node:test";
import assert from "node:assert/strict";
import { demoScan } from "../lib/demo.js";

test("demoScan fires on schedule and respects the threshold", () => {
  // Fires every 3rd cycle. Within six cycles we should see both a
  // non-triggered and a triggered result, each with usage.
  let sawTriggered = false;
  let sawClear = false;
  for (let i = 0; i < 6; i++) {
    const r = demoScan({
      mission: "watch the door",
      action: "say hi",
      threshold: 60,
    });
    assert.equal(r.mode, "demo");
    assert.ok(r.usage.total_tokens > 0);
    assert.equal(typeof r.reason, "string");
    if (r.triggered) {
      sawTriggered = true;
      assert.match(r.message, /^\(demo\)/); // announcements are clearly labeled
    } else {
      sawClear = true;
    }
  }
  assert.ok(sawTriggered && sawClear);
});

test("demoScan never produces a webhook message", () => {
  for (let i = 0; i < 6; i++) {
    const r = demoScan({ mission: "m", action: "a", threshold: 0 });
    assert.equal(r.webhookMessage, ""); // simulated alerts must not hit real webhooks
  }
});

test("demoScan never fires when threshold exceeds demo confidence", () => {
  for (let i = 0; i < 6; i++) {
    const r = demoScan({ mission: "m", action: "a", threshold: 95 });
    assert.equal(r.triggered, false); // demo confidence caps at 82
  }
});
