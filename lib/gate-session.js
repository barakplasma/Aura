// The object gate's per-session state machine — see docs/PRD-object-gate.md.
//
// useMonitor owns the camera, the canvas and the worker; this module owns
// every *decision*: when to re-baseline, when the heartbeat is due, when a
// still frame may skip the detector, what the detector's output means, how a
// pass the cadence floor deferred is remembered, and how long to leave a
// broken detector alone. Keeping those here, pure and clock-injected, is what
// lets a whole armed session — hours of it — run under `node --test` in
// milliseconds.
//
// Each tick walks the same three steps, and every step either *decides*
// (returns { decided: true, pass, why, hint, events }) or says which step to
// run next:
//
//   beginTick()   → baseline / owed pass / detector backoff / heartbeat check
//   afterMotion() → stage 0: skip a still frame, or ask for a detector pass
//   afterDetect() → stage 1: seed or step the tracks, decide on the events
//   detectFailed()→ stage 1 could not run: scan anyway, and back off
//
// plus the two things that happen outside a tick: scanCompleted() after the
// VLM ran, and seedFrom() for the cold-start inventory.
//
// The one invariant that matters: nothing here can stop the monitor scanning.
// Every uncertain path decides `pass: true`, and the heartbeat is unskippable.

import { motionScore, isMotion } from "./motion.js";
import {
  seedTracks,
  stepTracks,
  rebaseAnchors,
  summarize,
  summaryText,
  gateDecision,
  buildSceneHint,
} from "./object-gate.js";

// A detector that failed to load or run is retried on a doubling backoff from
// 5 s, capped at 5 minutes. Without it, an offline first run re-requests the
// model from the Hub on every 2 s tick for as long as the monitor is armed.
export const DETECT_RETRY_BASE_MS = 5000;
export const DETECT_RETRY_MAX_MS = 5 * 60 * 1000;

export function createGateState() {
  return {
    signature: null, // baseline identity: mission, camera, watch list, …
    tracks: [],
    seedNext: true, // the next detector pass seeds instead of stepping
    refGray: null, // stage 0 reference frame
    lastGray: null, // the most recent stage 0 frame, pending promotion
    lastScanAt: null, // wall ms of the last completed VLM scan
    pending: null, // { why, hint } — a pass the cadence floor deferred
    detectFailures: 0,
    detectRetryAt: 0,
    skips: 0,
    objects: "",
  };
}

function decided(pass, why, hint = "", events = []) {
  return { decided: true, pass, why, hint, events };
}

/** True when no track is waiting on another detector pass to resolve. */
export function tracksSettled(tracks) {
  return tracks.every((t) => t.state === "present");
}

/**
 * Start a tick. Decides outright for the cases that never consult the
 * cascade; otherwise reports whether the heartbeat is due and hands over to
 * stage 0.
 */
export function beginTick(state, { now, signature, heartbeatMs = 0 }) {
  // Cold start, and every rebase. A gate with no reference has nothing to
  // diff against, and ARM should give a verdict on what the camera sees now.
  // `lastScanAt == null` keeps this true until a scan actually completes, so
  // a failed first scan is retried rather than silently becoming the
  // baseline.
  if (state.signature !== signature || state.lastScanAt == null) {
    state.signature = signature;
    state.tracks = [];
    state.seedNext = true;
    state.refGray = null;
    state.lastGray = null;
    state.pending = null;
    state.objects = "";
    return decided(true, "baseline");
  }

  // A pass the cadence floor deferred is still owed a scan: the events that
  // justified it were consumed the tick they were emitted.
  if (state.pending) return decided(true, state.pending.why, state.pending.hint);

  // While the detector is backing off, behave exactly as if the gate were
  // off — scan at the mode's own cadence — rather than as if nothing changed.
  if (now < state.detectRetryAt) return decided(true, "gate unavailable");

  const heartbeatDue = heartbeatMs > 0 && now - state.lastScanAt >= heartbeatMs;
  return { decided: false, heartbeatDue };
}

/**
 * Stage 0. `gray` is this tick's 64x48 luma frame, or null when the frame
 * could not be read (in which case the detector gets to decide).
 */
export function afterMotion(state, { gray, preset, heartbeatDue = false }) {
  if (!gray) return { decided: false };
  state.lastGray = gray;
  // No reference yet (just after a baseline) → the detector must look.
  if (!state.refGray) return { decided: false };
  // A track mid-transition — a candidate waiting for its confirming sighting,
  // or a present object that just went missing — can only be resolved by the
  // detector looking again. Letting a still frame skip it here would strand
  // the candidate forever: a person who walks in and then stands still would
  // never be reported. Stage 0 may only skip when the tracker is settled.
  if (!tracksSettled(state.tracks)) return { decided: false };
  const score = motionScore(gray, state.refGray, preset);
  if (isMotion(score, preset) || heartbeatDue) return { decided: false, score };
  state.skips += 1;
  return decided(false, `still ${score.toFixed(2)}`);
}

/**
 * Stage 1. `detections` is decodeDetections()'s output for this frame, `opts`
 * the gate thresholds it was decoded with.
 */
export function afterDetect(
  state,
  { detections, opts, wakeOn, heartbeatDue = false, promptContext = false },
) {
  state.detectFailures = 0;
  state.detectRetryAt = 0;

  let events = [];
  if (state.seedNext) {
    state.tracks = seedTracks(detections);
    state.seedNext = false;
  } else {
    const stepped = stepTracks(state.tracks, detections, opts);
    state.tracks = stepped.tracks;
    events = stepped.events;
  }
  const counts = summarize(state.tracks);
  state.objects = summaryText(counts);

  const decision = gateDecision(events, { wakeOn, heartbeatDue });
  if (!decision.pass) {
    // The detector just looked at this frame and found nothing worth a scan,
    // so this frame is the new "normal" for stage 0. Without this the motion
    // reference would stay pinned to the last *scanned* frame, and any
    // persistent non-object change — a curtain, a lamp left on, a nudged
    // phone — would read as motion on every tick, running the detector
    // continuously until the next heartbeat. Safe even mid-transition:
    // afterMotion() refuses to skip while any track is unsettled.
    if (state.lastGray) state.refGray = state.lastGray;
    state.skips += 1;
  }
  const hint =
    decision.pass && promptContext ? buildSceneHint(counts, decision.events) : "";
  return decided(decision.pass, decision.why, hint, decision.events);
}

/**
 * Stage 1 could not run. Scan anyway — a broken gate must never silence the
 * monitor — and don't try the detector again until the backoff expires.
 */
export function detectFailed(state, { now }) {
  const delay = Math.min(
    DETECT_RETRY_MAX_MS,
    DETECT_RETRY_BASE_MS * 2 ** state.detectFailures,
  );
  state.detectFailures += 1;
  state.detectRetryAt = now + delay;
  return decided(true, "gate unavailable");
}

/**
 * A pass arrived before the mode's cadence floor allowed a scan. Remember it,
 * so the next tick scans without needing the events again.
 */
export function defer(state, decision) {
  state.pending = { why: decision.why, hint: decision.hint || "" };
  state.skips += 1;
}

/**
 * The VLM just scanned. Everything the gate diffs against rebases to now: the
 * motion reference becomes the frame the VLM judged, and every track
 * re-anchors where it stands — which is what makes movement "since the last
 * scan" rather than "since the last tick".
 *
 * Pass `gray` — the 64x48 frame grabbed alongside the scan's own capture.
 * Falling back to the last stage-0 frame is only right when stage 0 ran this
 * tick: a tick that decided early (baseline, an owed pass, detector backoff)
 * never grabbed one, and rebasing onto an older frame would let a scene that
 * returns to how it looked *then* read as "still" against what was scanned.
 */
export function scanCompleted(state, { now, gray = null }) {
  state.lastScanAt = now;
  const scanned = gray || state.lastGray;
  if (scanned) {
    state.refGray = scanned;
    state.lastGray = scanned;
  }
  state.tracks = rebaseAnchors(state.tracks);
  state.pending = null;
}

/**
 * Cold start: seed the inventory from the frame the baseline scan judged, so
 * everything already in shot enters as `present` and never emits `added`.
 * A no-op once something else has already seeded.
 */
export function seedFrom(state, detections) {
  if (!state.seedNext) return false;
  state.tracks = seedTracks(detections);
  state.seedNext = false;
  state.objects = summaryText(summarize(state.tracks));
  return true;
}
