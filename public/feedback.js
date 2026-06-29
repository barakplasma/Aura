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
const HOLD_PULSE_INTERVAL_MS = 500; // cadence of the "locked" solid pulse

let lastAction = null;
let lastSpeechAt = 0;
let lastHoldPulseAt = 0;

const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;
const canSpeak =
  typeof window !== 'undefined' && 'speechSynthesis' in window;

export function resetFeedback() {
  lastAction = null;
  lastSpeechAt = 0;
  lastHoldPulseAt = 0;
  if (canVibrate) navigator.vibrate(0);
  if (canSpeak) window.speechSynthesis.cancel();
}

// Drive both feedback channels for a single guidance result.
// `result` is { found, x, y, action }; `opts` toggles each channel.
export function drive(result, opts = {}) {
  const speech = opts.speech !== false;
  const haptics = opts.haptics !== false;
  const now = Date.now();

  if (!result.found) {
    // Gentle, infrequent "still searching" tick.
    if (haptics && now - lastHoldPulseAt > 1200) {
      vibrate(30);
      lastHoldPulseAt = now;
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
    // Target locked: continuous solid pulse, re-issued on a steady cadence so
    // it feels sustained without overlapping calls.
    if (now - lastHoldPulseAt > HOLD_PULSE_INTERVAL_MS) {
      navigator.vibrate([400]);
      lastHoldPulseAt = now;
    }
    return;
  }

  // Off-center: rapid dual-pulse warning. Cadence tightens as the target nears
  // center, so the haptics "grow more solid" as the hand closes in.
  const dist = Math.hypot(result.x - 50, result.y - 50); // 0..~70
  const interval = 180 + Math.min(dist, 50) * 8; // closer => faster repeats
  if (now - lastHoldPulseAt > interval) {
    navigator.vibrate([100, 50, 100]);
    lastHoldPulseAt = now;
  }
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
