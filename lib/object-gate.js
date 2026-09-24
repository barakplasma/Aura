// Aura object-inventory gate — see docs/PRD-object-gate.md.
//
// Pure functions: decode a YOLO26 ONNX output into detections, track those
// detections across ticks with hysteresis, and decide whether the change is
// worth waking the vision-language model for. No DOM, no Worker, no
// Transformers.js — the worker hands the raw tensors over and this module does
// the rest, which is what makes every rule below unit-testable.
//
// The whole point of the hysteresis is that a detector's score wobbles. A
// chair scoring 0.31 / 0.29 / 0.33 must NOT read as removed → added → removed:
// each of those would wake a 450M model on a scene where nothing happened.

import { COCO_LABELS } from "./detector-models.js";

// Sensitivity presets. `enter` creates a track, `exit` is the lower bar an
// existing track only has to clear to stay alive — the two-tier threshold is
// the first half of the anti-flicker story, the frame counts are the second.
export const GATE_PRESETS = {
  low: { enterScore: 0.5, exitScore: 0.35, enterFrames: 3, exitFrames: 4 },
  medium: { enterScore: 0.35, exitScore: 0.25, enterFrames: 2, exitFrames: 3 },
  high: { enterScore: 0.25, exitScore: 0.15, enterFrames: 1, exitFrames: 2 },
};

export const DEFAULT_GATE_OPTS = {
  ...GATE_PRESETS.medium,
  iouMin: 0.3,
  moveFrac: 0.15,
  // IoU alone cannot associate an object across a 2-second gap: a walking
  // person clears their own bounding-box width in well under that, and two
  // non-overlapping boxes have IoU 0. Falling back to nearest-centre matching
  // for same-class boxes of comparable size is what keeps one person walking
  // across the frame reading as `moved` instead of a stream of
  // removed + added pairs — each of which would wake the VLM.
  matchMoveFrac: 0.35,
  matchAreaRatio: 4,
};

/** Preset by name, defaulting to medium for unknown input. */
export function gateOpts(sensitivity, overrides = {}) {
  const preset = GATE_PRESETS[sensitivity] || GATE_PRESETS.medium;
  return { ...DEFAULT_GATE_OPTS, ...preset, ...overrides };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/**
 * Decode one YOLO26 ONNX forward pass.
 *
 * `logits` is [numQueries, numClasses] and **raw** — traced through the
 * onnx-community export, the classification head's Conv output reaches the
 * graph output with no Sigmoid in between. Scores are therefore per-class
 * sigmoid, NOT softmax: there is no background class to argmax against, which
 * is exactly why transformers.js's own post_process_object_detection() is the
 * wrong tool here.
 *
 * `boxes` is [numQueries, 4] as normalized cx, cy, w, h. Output boxes are
 * normalized x1, y1, x2, y2 — they are only ever compared against other boxes
 * from the same pipeline, so they are never converted back to pixels.
 *
 * No NMS: YOLO26's end-to-end head assigns one query per object.
 */
export function decodeDetections(logits, boxes, dims, opts = {}) {
  const { minScore = 0.25, classFilter = null, labels = COCO_LABELS } = opts;
  const [numQueries, numClasses] = dims;
  const allow = classFilter ? new Set(classFilter) : null;
  const out = [];
  for (let q = 0; q < numQueries; q++) {
    const base = q * numClasses;
    let best = -Infinity;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c++) {
      const v = logits[base + c];
      if (v > best) {
        best = v;
        bestClass = c;
      }
    }
    if (bestClass < 0) continue;
    const score = sigmoid(best);
    if (score < minScore) continue;
    const label = labels[bestClass] ?? String(bestClass);
    if (allow && !allow.has(label)) continue;
    const b = q * 4;
    const cx = boxes[b];
    const cy = boxes[b + 1];
    const w = boxes[b + 2];
    const h = boxes[b + 3];
    out.push({
      classId: bestClass,
      label,
      score,
      box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
    });
  }
  return out;
}

/** Intersection-over-union of two [x1,y1,x2,y2] boxes. */
export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function centre(box) {
  return [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function area(box) {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

let nextTrackId = 1;

function makeTrack(det, state) {
  return {
    id: nextTrackId++,
    classId: det.classId,
    label: det.label,
    box: det.box,
    score: det.score,
    state,
    hits: 1,
    misses: 0,
    // Position at the last VLM scan, not at the last tick — see rebaseAnchors().
    anchor: centre(det.box),
    movedReported: false,
  };
}

/**
 * Seed a fresh inventory from one frame, with every object entering at
 * `present`.
 *
 * This is the cold start: arming runs a full VLM scan and seeds from that same
 * frame, so the couch that was already in shot never emits `added` two ticks
 * later. Seeded tracks skip `candidate` entirely, which is the whole
 * difference between this and stepTracks() on an empty track list.
 */
export function seedTracks(detections) {
  return detections.map((d) => makeTrack(d, "present"));
}

/**
 * Advance the tracker by one detector frame.
 *
 * Matching is greedy within a class: IoU first, then nearest centre for boxes
 * that no longer overlap (see matchMoveFrac). With under a dozen live tracks,
 * Hungarian assignment buys nothing measurable. Only two transitions emit
 * events, and they are the only two things that can wake the VLM:
 *   candidate --(enterFrames consecutive hits)--> present   emits 'added'
 *   fading    --(exitFrames consecutive misses)--> gone     emits 'removed'
 * plus 'moved', which a present track emits once per scan when its centre has
 * travelled further than moveFrac from its anchor.
 *
 * Returns new state; never mutates the tracks passed in.
 */
export function stepTracks(tracks, detections, opts = {}) {
  const o = { ...DEFAULT_GATE_OPTS, ...opts };
  const events = [];
  // Work on copies so a caller holding the previous array keeps a valid
  // snapshot (React state, tests asserting on both).
  const live = tracks.map((t) => ({ ...t }));
  const unmatchedDets = new Set(detections.keys());
  const matchedTracks = new Set();

  // Every plausible (track, detection) pair, best first. A pair is only
  // plausible when the classes agree: a person walking in front of a chair
  // must not "become" the chair. Overlapping pairs are preferred outright;
  // non-overlapping ones are ranked behind them by how far the centre moved,
  // so a stationary match always beats a travelled one.
  const pairs = [];
  for (let ti = 0; ti < live.length; ti++) {
    for (let di = 0; di < detections.length; di++) {
      if (live[ti].classId !== detections[di].classId) continue;
      const overlap = iou(live[ti].box, detections[di].box);
      if (overlap >= o.iouMin) {
        pairs.push({ ti, di, rank: 1 + overlap });
        continue;
      }
      const moved = distance(centre(live[ti].box), centre(detections[di].box));
      if (moved > o.matchMoveFrac) continue;
      // A detection an order of magnitude bigger or smaller than the track is
      // a different object that happens to share a label, not the same one
      // having travelled.
      const ratio = area(detections[di].box) / Math.max(area(live[ti].box), 1e-9);
      if (ratio > o.matchAreaRatio || ratio < 1 / o.matchAreaRatio) continue;
      pairs.push({ ti, di, rank: 1 - moved / o.matchMoveFrac });
    }
  }
  pairs.sort((a, b) => b.rank - a.rank);
  for (const { ti, di } of pairs) {
    if (matchedTracks.has(ti) || !unmatchedDets.has(di)) continue;
    matchedTracks.add(ti);
    unmatchedDets.delete(di);
    const track = live[ti];
    const det = detections[di];
    track.box = det.box;
    track.score = det.score;
    track.misses = 0;
    if (track.state === "candidate") {
      track.hits += 1;
      if (track.hits >= o.enterFrames) {
        track.state = "present";
        track.anchor = centre(det.box);
        events.push({ kind: "added", label: track.label, id: track.id, box: det.box });
      }
    } else {
      // A fading track that reappears is the same object, not a new one — it
      // returns to `present` silently. Emitting 'added' here is precisely the
      // flicker this design exists to prevent.
      track.state = "present";
      track.hits += 1;
      if (
        !track.movedReported &&
        distance(centre(det.box), track.anchor) > o.moveFrac
      ) {
        track.movedReported = true;
        events.push({ kind: "moved", label: track.label, id: track.id, box: det.box });
      }
    }
  }

  // Tracks with no detection this tick.
  const kept = [];
  for (let ti = 0; ti < live.length; ti++) {
    const track = live[ti];
    if (matchedTracks.has(ti)) {
      kept.push(track);
      continue;
    }
    track.misses += 1;
    if (track.state === "candidate") continue; // noise; drop silently
    if (track.state === "present") {
      track.state = "fading";
      kept.push(track);
      continue;
    }
    // fading
    if (track.misses >= o.exitFrames) {
      events.push({ kind: "removed", label: track.label, id: track.id, box: track.box });
      continue;
    }
    kept.push(track);
  }

  // Detections that matched nothing start as candidates. Only a detection
  // confident enough to clear the *enter* bar may create one; the decode pass
  // runs at the lower exit bar, and those weaker detections exist solely to
  // keep an already-present track alive.
  for (const di of unmatchedDets) {
    const det = detections[di];
    if (det.score < o.enterScore) continue;
    const track = makeTrack(det, o.enterFrames <= 1 ? "present" : "candidate");
    if (track.state === "present")
      events.push({ kind: "added", label: track.label, id: track.id, box: det.box });
    kept.push(track);
  }

  return { tracks: kept, events };
}

/**
 * Re-anchor every present track to where it is now, and clear the one-shot
 * `moved` latch. Called after each VLM scan, which is what makes movement
 * "displacement since the last scan" rather than "since the last tick" —
 * per-tick deltas would let a slow walker cross the whole frame without ever
 * tripping the threshold, while box jitter on a stationary object tripped it
 * constantly.
 */
export function rebaseAnchors(tracks) {
  return tracks.map((t) => ({
    ...t,
    anchor: centre(t.box),
    movedReported: false,
  }));
}

/** Counts per label for tracks the operator would say are "there". */
export function summarize(tracks) {
  const counts = {};
  for (const t of tracks) {
    if (t.state === "candidate") continue;
    counts[t.label] = (counts[t.label] || 0) + 1;
  }
  return counts;
}

/** "person x2 · chair x1" — the OBJECTS telemetry row, and the prompt hint. */
export function summaryText(counts) {
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, n]) => `${label} x${n}`);
  return parts.join(" · ");
}

/** `'added,removed'` → Set. Unknown kinds are ignored, empty means nothing. */
export function parseWakeOn(raw) {
  const kinds = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s === "added" || s === "removed" || s === "moved");
  return new Set(kinds);
}

/**
 * Should this tick wake the vision model?
 *
 * The heartbeat overrides everything and is never skippable: 80 COCO classes
 * cannot express "the stove was left on", so a gate that could suppress every
 * scan indefinitely would be a false-negative machine.
 */
export function gateDecision(events, opts = {}) {
  const { wakeOn = "added,removed", heartbeatDue = false } = opts;
  if (heartbeatDue) return { pass: true, why: "heartbeat", events: [] };
  const kinds = wakeOn instanceof Set ? wakeOn : parseWakeOn(wakeOn);
  const matching = events.filter((e) => kinds.has(e.kind));
  if (matching.length === 0)
    return {
      pass: false,
      why: events.length > 0 ? "no change that matters" : "no object change",
      events: [],
    };
  const first = matching[0];
  const extra = matching.length > 1 ? ` +${matching.length - 1}` : "";
  return { pass: true, why: `${first.kind} ${first.label}${extra}`, events: matching };
}

/**
 * The one line of scene context handed to the VLM when ADD OBJECTS TO PROMPT
 * is on. Returns "" when there's nothing useful to say, so the prompt is
 * byte-identical to the ungated one in that case.
 */
export function buildSceneHint(counts, events = []) {
  const now = summaryText(counts);
  if (!now && events.length === 0) return "";
  const lines = [];
  if (now) lines.push(`A local object detector sees: ${now}.`);
  const added = events.filter((e) => e.kind === "added").map((e) => e.label);
  const removed = events.filter((e) => e.kind === "removed").map((e) => e.label);
  if (added.length) lines.push(`New since the last check: ${[...new Set(added)].join(", ")}.`);
  if (removed.length)
    lines.push(`Gone since the last check: ${[...new Set(removed)].join(", ")}.`);
  return lines.join(" ");
}

// Test hook — track ids are a module-level counter, which makes assertions on
// them brittle across test files unless it can be reset.
export function _resetTrackIds() {
  nextTrackId = 1;
}
