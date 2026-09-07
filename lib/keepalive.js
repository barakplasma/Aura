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

// Backoff schedule for reconnecting a lost/ended camera track: 1s, 3s, 8s,
// then give up (null) so the caller can stop() with an explanatory status
// instead of retrying forever. `attempt` is 1-indexed (the delay before the
// Nth retry).
const RECONNECT_DELAYS_MS = [1000, 3000, 8000];
export function nextReconnectDelayMs(attempt) {
  return RECONNECT_DELAYS_MS[attempt - 1] ?? null;
}
