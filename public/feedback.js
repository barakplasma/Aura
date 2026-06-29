// Aura feedback driver — translates spatial guidance into physical feedback
// using only built-in browser capabilities.
//
//   Web Vibration API  -> distance / lock haptics  (navigator.vibrate)
//   Web Speech API     -> directional voice cues    (speechSynthesis)
//
// Both channels are deliberately rate-limited and de-duplicated: we only re-fire
// when the guidance meaningfully changes, and voice always reflects the *latest*
// state (the queue is cancelled before each new utterance) so audio never lags
// behind the user's hand.

const SPEECH_PHRASES = {
  steer_left: 'Left',
  steer_right: 'Right',
  steer_up: 'Up',
  steer_down: 'Down',
  hold_center: 'Hold. Reach now.',
};

const SPEECH_MIN_INTERVAL_MS = 900; // floor between spoken cues (same action)
const SPEECH_CHANGE_FLOOR_MS = 400; // hard floor even when the action changes

// Parking-sensor haptics. Direction is spoken; the vibration encodes how close
// you are: slow, short taps when far → fast, longer buzzes as you close in →
// one sustained buzz when locked on target. The wide ranges below make the
// "getting warmer" change unmistakable on a phone.
const HOLD_BUZZ_MS = 700;        // length of the sustained "locked" buzz
const HOLD_REFRESH_MS = 600;     // re-issue cadence so it feels continuous
const FAR_INTERVAL_MS = 650;     // gap between taps when far from center
const NEAR_INTERVAL_MS = 120;    // gap between taps when almost centered
const FAR_PULSE_MS = 120;        // tap length when far
const NEAR_PULSE_MS = 230;       // tap length when almost centered
const DIST_FAR = 70;             // ~corner distance on the 0–100 grid
const DIST_NEAR = 15;            // edge of the center dead-zone

export const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;
const canSpeak =
  typeof window !== 'undefined' && 'speechSynthesis' in window;

let lastAction = null;
let lastSpeechAt = 0;
let lastHapticAt = 0;
let lastHapticAction = null;

export function resetFeedback() {
  lastAction = null;
  lastSpeechAt = 0;
  lastHapticAt = 0;
  lastHapticAction = null;
  if (canVibrate) navigator.vibrate(0);
  if (canSpeak) window.speechSynthesis.cancel();
}

// Fire a recognizable test pattern so the user can confirm their device/browser
// actually vibrates (iOS Safari, for one, has no Vibration API at all).
// Returns false when vibration is unsupported.
export function testVibration() {
  if (!canVibrate) return false;
  return navigator.vibrate([200, 120, 200, 120, 500]);
}

// Drive both feedback channels for a single guidance result.
// `result` is { found, x, y, action }; `opts` toggles each channel.
export function drive(result, opts = {}) {
  const speech = opts.speech !== false;
  const haptics = opts.haptics !== false;
  const now = Date.now();

  if (!result.found) {
    // Gentle, infrequent "still searching" tick.
    if (haptics && now - lastHapticAt > 1200) {
      vibrate(30);
      lastHapticAt = now;
    }
    if (speech && lastAction !== 'searching' && now - lastSpeechAt > 1500) {
      speak('Searching');
      lastAction = 'searching';
      lastSpeechAt = now;
    }
    return;
  }

  const actionChanged = result.action !== lastAction;

  if (haptics) driveHaptics(result, now);
  if (speech) driveSpeech(result, now, actionChanged);

  lastAction = result.action;
}

function driveHaptics(result, now) {
  if (!canVibrate) return;

  if (result.action === 'hold_center') {
    // Just locked on: a punchy double-buzz marks the transition distinctly.
    if (lastHapticAction !== 'hold_center') {
      navigator.vibrate([300, 90, 300]);
      lastHapticAt = now;
      lastHapticAction = 'hold_center';
      return;
    }
    // Sustained solid buzz while held, re-issued so it feels continuous.
    if (now - lastHapticAt > HOLD_REFRESH_MS) {
      navigator.vibrate(HOLD_BUZZ_MS);
      lastHapticAt = now;
    }
    return;
  }

  // Off-center: a single tap whose rate and length both ramp with proximity,
  // like a parking sensor accelerating as you approach. proximity: 0 far → 1 near.
  const dist = Math.hypot(result.x - 50, result.y - 50);
  const proximity = clamp01((DIST_FAR - dist) / (DIST_FAR - DIST_NEAR));
  const interval = lerp(FAR_INTERVAL_MS, NEAR_INTERVAL_MS, proximity);
  if (now - lastHapticAt > interval) {
    navigator.vibrate(Math.round(lerp(FAR_PULSE_MS, NEAR_PULSE_MS, proximity)));
    lastHapticAt = now;
    lastHapticAction = result.action;
  }
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function driveSpeech(result, now, actionChanged) {
  if (!canSpeak) return;
  // A direction change speaks promptly, but always honor a small absolute floor
  // so rapidly flipping actions can't fire cancel()/speak() fast enough to
  // stutter or permanently lock the synthesis queue (notably iOS Safari).
  // Unchanged actions respect the longer anti-chatter floor.
  const minInterval = actionChanged ? SPEECH_CHANGE_FLOOR_MS : SPEECH_MIN_INTERVAL_MS;
  if (now - lastSpeechAt < minInterval) return;
  const phrase = SPEECH_PHRASES[result.action];
  if (!phrase) return;
  speak(phrase);
  lastSpeechAt = now;
}

function speak(text) {
  if (!canSpeak) return;
  // Clear any pending utterance so feedback reflects only the latest frame.
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.4; // accelerated for tight closed-loop guidance
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

function vibrate(pattern) {
  if (canVibrate) navigator.vibrate(pattern);
}
