// Aura feedback — alert delivery using only built-in browser capabilities.
//
//   Web Speech API     -> speak the announcement aloud (speechSynthesis)
//   Web Vibration API  -> a distinct alert buzz          (navigator.vibrate)

export const canVibrate = typeof navigator !== 'undefined' && 'vibrate' in navigator;
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

export function resetFeedback() {
  if (canVibrate) navigator.vibrate(0);
  if (canSpeak) window.speechSynthesis.cancel();
}

// Fire a recognizable test pattern so the user can confirm their device/browser
// actually vibrates (iOS Safari, for one, has no Vibration API at all).
export function testVibration() {
  if (!canVibrate) return false;
  return navigator.vibrate([200, 120, 200, 120, 500]);
}

// Deliver an alert: a distinct buzz, then speak the announcement. The speech
// queue is cleared first so a fresh, urgent alert isn't stuck behind an older
// one. `opts` toggles each channel.
export function alert(message, opts = {}) {
  const speech = opts.speech !== false;
  const haptics = opts.haptics !== false;

  if (haptics && canVibrate) {
    navigator.vibrate([300, 100, 300, 100, 300]);
  }
  if (speech && canSpeak && message) {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(message);
    u.rate = 1.1; // clear and assertive for a broadcast announcement
    u.volume = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }
}
