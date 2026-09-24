import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeDetections,
  iou,
  seedTracks,
  stepTracks,
  rebaseAnchors,
  summarize,
  summaryText,
  parseWakeOn,
  gateDecision,
  buildSceneHint,
  gateOpts,
  _resetTrackIds,
} from "../lib/object-gate.js";
import { COCO_LABELS } from "../lib/detector-models.js";

// --- helpers ---------------------------------------------------------------

const logit = (p) => Math.log(p / (1 - p));

// Build a [queries, classes] logits array + [queries, 4] cxcywh box array from
// a list of {classId, score, box:[cx,cy,w,h]}. Everything not listed gets a
// very negative logit, i.e. sigmoid ≈ 0.
function fakeOutput(items, queries = 4, classes = 80) {
  const logits = new Float32Array(queries * classes).fill(-20);
  const boxes = new Float32Array(queries * 4);
  items.forEach((item, q) => {
    logits[q * classes + item.classId] = logit(item.score);
    boxes.set(item.box, q * 4);
  });
  return { logits, boxes, dims: [queries, classes] };
}

const CLS = {
  person: COCO_LABELS.indexOf("person"),
  chair: COCO_LABELS.indexOf("chair"),
  backpack: COCO_LABELS.indexOf("backpack"),
};

// A detection as stepTracks() consumes it (xyxy, normalized).
function det(label, score, [x, y, w = 0.1, h = 0.2]) {
  return {
    classId: COCO_LABELS.indexOf(label),
    label,
    score,
    box: [x - w / 2, y - h / 2, x + w / 2, y + h / 2],
  };
}

const OPTS = gateOpts("medium"); // enter .35/2 frames, exit .25/3 frames

// --- decode ----------------------------------------------------------------

test("decodeDetections applies sigmoid per class, not softmax", () => {
  // Two classes both at logit 0 → sigmoid 0.5 each. Softmax over 80 classes
  // would put every score near 1/80 and decode nothing.
  const { logits, boxes, dims } = fakeOutput(
    [{ classId: CLS.person, score: 0.5, box: [0.5, 0.5, 0.2, 0.4] }],
    1,
  );
  const out = decodeDetections(logits, boxes, dims, { minScore: 0.4 });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "person");
  assert.ok(Math.abs(out[0].score - 0.5) < 1e-6);
});

test("decodeDetections picks the argmax class and converts cxcywh → xyxy", () => {
  const { logits, boxes, dims } = fakeOutput(
    [{ classId: CLS.chair, score: 0.9, box: [0.5, 0.5, 0.2, 0.4] }],
    1,
  );
  const [d] = decodeDetections(logits, boxes, dims, { minScore: 0.25 });
  assert.equal(d.label, "chair");
  assert.deepEqual(
    d.box.map((v) => Number(v.toFixed(4))),
    [0.4, 0.3, 0.6, 0.7],
  );
});

test("decodeDetections drops sub-threshold and filtered-out classes", () => {
  const { logits, boxes, dims } = fakeOutput([
    { classId: CLS.person, score: 0.8, box: [0.2, 0.5, 0.1, 0.2] },
    { classId: CLS.chair, score: 0.8, box: [0.8, 0.5, 0.1, 0.2] },
    { classId: CLS.person, score: 0.1, box: [0.5, 0.5, 0.1, 0.2] },
  ]);
  const all = decodeDetections(logits, boxes, dims, { minScore: 0.25 });
  assert.equal(all.length, 2, "the 0.1-score query is below threshold");
  const filtered = decodeDetections(logits, boxes, dims, {
    minScore: 0.25,
    classFilter: ["person"],
  });
  assert.deepEqual(
    filtered.map((d) => d.label),
    ["person"],
  );
});

test("iou is 0 for disjoint boxes and 1 for identical ones", () => {
  assert.equal(iou([0, 0, 1, 1], [0, 0, 1, 1]), 1);
  assert.equal(iou([0, 0, 0.1, 0.1], [0.5, 0.5, 0.6, 0.6]), 0);
});

// --- hysteresis ------------------------------------------------------------

test("a new object emits exactly one 'added', after enterFrames", () => {
  _resetTrackIds();
  let tracks = [];
  const person = [det("person", 0.8, [0.5, 0.5])];

  let r = stepTracks(tracks, person, OPTS);
  assert.deepEqual(r.events, [], "first sighting is a candidate, not an event");
  tracks = r.tracks;

  r = stepTracks(tracks, person, OPTS);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "added");
  assert.equal(r.events[0].label, "person");
  tracks = r.tracks;

  r = stepTracks(tracks, person, OPTS);
  assert.deepEqual(r.events, [], "a present object does not keep emitting");
});

test("score wobble across the threshold emits nothing (the whole point)", () => {
  _resetTrackIds();
  // A chair hovering either side of enterScore 0.35, never below exitScore.
  let tracks = seedTracks([det("chair", 0.33, [0.5, 0.5])]);
  const wobble = [0.31, 0.29, 0.33, 0.27, 0.36, 0.28];
  for (const score of wobble) {
    const r = stepTracks(tracks, [det("chair", score, [0.5, 0.5])], OPTS);
    assert.deepEqual(r.events, [], `score ${score} must not emit`);
    tracks = r.tracks;
  }
  assert.equal(summarize(tracks).chair, 1);
});

test("a departing object emits one 'removed', not before exitFrames", () => {
  _resetTrackIds();
  let tracks = seedTracks([det("backpack", 0.7, [0.5, 0.5])]);
  // exitFrames 3: two empty frames fade it, the third removes it.
  let r = stepTracks(tracks, [], OPTS);
  assert.deepEqual(r.events, []);
  assert.equal(r.tracks[0].state, "fading");
  r = stepTracks(r.tracks, [], OPTS);
  assert.deepEqual(r.events, []);
  r = stepTracks(r.tracks, [], OPTS);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].kind, "removed");
  assert.equal(r.events[0].label, "backpack");
  assert.equal(r.tracks.length, 0);
});

test("a fading object that comes back emits nothing at all", () => {
  _resetTrackIds();
  let tracks = seedTracks([det("person", 0.8, [0.5, 0.5])]);
  let r = stepTracks(tracks, [], OPTS); // occluded for one tick
  assert.equal(r.tracks[0].state, "fading");
  r = stepTracks(r.tracks, [det("person", 0.8, [0.52, 0.5])], OPTS);
  assert.deepEqual(r.events, [], "re-acquiring is not an arrival");
  assert.equal(r.tracks[0].state, "present");
});

test("a weak detection can sustain a track but never create one", () => {
  _resetTrackIds();
  // 0.3 is above exitScore (0.25) but below enterScore (0.35).
  const weak = [det("person", 0.3, [0.5, 0.5])];
  let r = stepTracks([], weak, OPTS);
  assert.equal(r.tracks.length, 0, "too weak to open a track");
  r = stepTracks(seedTracks([det("person", 0.8, [0.5, 0.5])]), weak, OPTS);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.tracks[0].state, "present");
});

test("one object moving is 'moved', never removed+added", () => {
  _resetTrackIds();
  let tracks = seedTracks([det("person", 0.8, [0.2, 0.5])]);
  // Drift 0.04 per tick against moveFrac 0.15: nothing until the 4th tick,
  // which lands 0.16 from the anchor.
  const steps = [0.24, 0.28, 0.32, 0.36];
  const kinds = [];
  for (const x of steps) {
    const r = stepTracks(tracks, [det("person", 0.8, [x, 0.5])], OPTS);
    kinds.push(r.events.map((e) => e.kind));
    tracks = r.tracks;
  }
  assert.deepEqual(kinds, [[], [], [], ["moved"]]);
  assert.equal(tracks.length, 1, "still one track, not a remove + add");
});

test("'moved' fires once per scan, and rebaseAnchors re-arms it", () => {
  _resetTrackIds();
  let tracks = seedTracks([det("person", 0.8, [0.2, 0.5])]);
  let r = stepTracks(tracks, [det("person", 0.8, [0.5, 0.5])], OPTS);
  assert.deepEqual(r.events.map((e) => e.kind), ["moved"]);
  // Same position again: already reported, so no repeat.
  r = stepTracks(r.tracks, [det("person", 0.8, [0.5, 0.5])], OPTS);
  assert.deepEqual(r.events, []);
  // A scan happened — re-anchor, then move again.
  const rebased = rebaseAnchors(r.tracks);
  r = stepTracks(rebased, [det("person", 0.8, [0.8, 0.5])], OPTS);
  assert.deepEqual(r.events.map((e) => e.kind), ["moved"]);
});

test("jitter within moveFrac never emits 'moved'", () => {
  _resetTrackIds();
  let tracks = seedTracks([det("person", 0.8, [0.5, 0.5])]);
  for (const dx of [0.01, -0.02, 0.03, -0.01, 0.02]) {
    const r = stepTracks(tracks, [det("person", 0.8, [0.5 + dx, 0.5])], OPTS);
    assert.deepEqual(r.events, []);
    tracks = r.tracks;
  }
});

test("seeded tracks are present immediately, so furniture never emits 'added'", () => {
  _resetTrackIds();
  const tracks = seedTracks([
    det("couch", 0.6, [0.3, 0.7]),
    det("chair", 0.5, [0.7, 0.7]),
  ]);
  assert.deepEqual(
    tracks.map((t) => t.state),
    ["present", "present"],
  );
  const r = stepTracks(
    tracks,
    [det("couch", 0.6, [0.3, 0.7]), det("chair", 0.5, [0.7, 0.7])],
    OPTS,
  );
  assert.deepEqual(r.events, []);
});

test("two objects of different classes at the same spot stay distinct", () => {
  _resetTrackIds();
  const tracks = seedTracks([det("person", 0.8, [0.5, 0.5])]);
  const r = stepTracks(tracks, [det("chair", 0.8, [0.5, 0.5])], OPTS);
  // The chair may not "become" the person: the person fades, the chair opens
  // a candidate.
  assert.equal(r.tracks.length, 2);
  assert.equal(r.tracks.find((t) => t.label === "person").state, "fading");
  assert.equal(r.tracks.find((t) => t.label === "chair").state, "candidate");
});

test("enterFrames 1 (HIGH sensitivity) emits on first sight", () => {
  _resetTrackIds();
  const r = stepTracks([], [det("person", 0.6, [0.5, 0.5])], gateOpts("high"));
  assert.deepEqual(r.events.map((e) => e.kind), ["added"]);
});

// --- summaries and decisions ----------------------------------------------

test("summarize counts present tracks only, summaryText is stable", () => {
  _resetTrackIds();
  const tracks = [
    ...seedTracks([det("person", 0.8, [0.2, 0.5]), det("person", 0.8, [0.8, 0.5])]),
    { ...seedTracks([det("chair", 0.5, [0.5, 0.9])])[0], state: "candidate" },
  ];
  assert.deepEqual(summarize(tracks), { person: 2 });
  assert.equal(summaryText({ person: 2, chair: 1 }), "person x2 · chair x1");
  assert.equal(summaryText({}), "");
});

test("parseWakeOn ignores unknown kinds", () => {
  assert.deepEqual([...parseWakeOn("added,removed")], ["added", "removed"]);
  assert.deepEqual([...parseWakeOn("added, moved , nonsense")], ["added", "moved"]);
  assert.deepEqual([...parseWakeOn("")], []);
});

test("gateDecision filters by wakeOn", () => {
  const events = [{ kind: "moved", label: "person" }];
  assert.equal(gateDecision(events, { wakeOn: "added,removed" }).pass, false);
  const on = gateDecision(events, { wakeOn: "added,removed,moved" });
  assert.equal(on.pass, true);
  assert.equal(on.why, "moved person");
});

test("gateDecision: heartbeat overrides everything, no events means no wake", () => {
  assert.deepEqual(gateDecision([], { heartbeatDue: true }), {
    pass: true,
    why: "heartbeat",
    events: [],
  });
  const idle = gateDecision([], { wakeOn: "added,removed" });
  assert.equal(idle.pass, false);
  assert.equal(idle.why, "no object change");
});

test("gateDecision reports the extra events it is passing on", () => {
  const d = gateDecision(
    [
      { kind: "added", label: "person" },
      { kind: "added", label: "backpack" },
    ],
    { wakeOn: "added" },
  );
  assert.equal(d.why, "added person +1");
  assert.equal(d.events.length, 2);
});

test("buildSceneHint is empty when there is nothing to say", () => {
  assert.equal(buildSceneHint({}, []), "");
  assert.equal(
    buildSceneHint({ person: 1, backpack: 1 }, [{ kind: "added", label: "backpack" }]),
    "A local object detector sees: backpack x1 · person x1. New since the last check: backpack.",
  );
});
