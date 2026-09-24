// Aura keepalive — pure helpers for surviving the ordinary ways a long-running
// monitor session gets interrupted: a throttled/backgrounded tab, a lost
// camera track, a reload. No DOM/browser APIs here so this stays Node-testable
// (node --test) and importable from both the scan loop and test/.

// True once the gap since the last successful scan is more than double the
// scheduled cadence — the sign that the tab was hidden/throttled and the
// operator deserves a fresh scan the instant they look, rather than waiting
// out whatever's left of a throttled interval. A session that hasn't scanned
// yet (lastScanAt not finite) always wants to catch up.
export function shouldCatchUp(lastScanAt, gapMs, now) {
  if (!Number.isFinite(lastScanAt)) return true;
  return now - lastScanAt > 2 * gapMs;
}

// True while a "RESUME MONITORING" offer is still worth showing after a
// reload: the session was armed, and that arming happened within the last
// maxAgeMs. An unarmed session (armedAt falsy) or a clock-skewed future
// timestamp never opens the window.
export function resumeWindowOpen(armedAt, now, maxAgeMs) {
  if (!armedAt) return false;
  const age = now - armedAt;
  if (age < 0) return false;
  return age <= maxAgeMs;
}

// Backoff schedule for reconnecting a lost/ended camera track. Visible, the
// ladder is 1s → 3s → 8s → 15s → 30s → 60s, then null so the caller can
// stop() with an explanatory status instead of retrying forever. The old
// ladder stopped at 8s (≈12s total), and any occlusion longer than that
// disarmed the session — on this Pixel the notification shade alone can eat
// 12s. While the tab is hidden the ladder is not even consulted meaningfully:
// Android refuses getUserMedia to backgrounded Chrome ("cannot open camera
// \"0\" from background", seen in dev-phone-ready runs), so a hidden failure
// is the OS's decision, not a camera fault. `hidden` therefore holds a slow
// 30s cadence and NEVER returns null — the give-up only happens to a visible
// operator who can actually act on "tap ARM".
//
// `attempt` is 1-indexed (the delay before the Nth retry).
const RECONNECT_DELAYS_MS = [1000, 3000, 8000, 15000, 30000, 60000];
const RECONNECT_HIDDEN_DELAY_MS = 30000;
export function nextReconnectDelayMs(attempt, hidden = false) {
  if (hidden) return RECONNECT_HIDDEN_DELAY_MS;
  return RECONNECT_DELAYS_MS[attempt - 1] ?? null;
}
// Ladder length, exported so the hook's "(n/N)" status and this table cannot
// drift apart.
export const RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;
