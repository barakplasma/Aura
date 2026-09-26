import test from "node:test";
import assert from "node:assert/strict";
import {
  createGateState,
  beginTick,
  afterMotion,
  afterDetect,
  detectFailed,
  defer,
  scanCompleted,
  seedFrom,
  DETECT_RETRY_BASE_MS,
  DETECT_RETRY_MAX_MS,
} from "../lib/gate-session.js";
import { gateOpts, _resetTrackIds } from "../lib/object-gate.js";
import { MOTION_PRESETS, GATE_WIDTH, GATE_HEIGHT } from "../lib/motion.js";
import { det } from "./gate-fixtures.js";

// --- a tiny simulated camera ------------------------------------------------

const N = GATE_WIDTH * GATE_HEIGHT;
const PRESET = MOTION_PRESETS.medium;
const OPTS = gateOpts("medium"); // enter 2 frames, exit 3
const SIG = "watch the door|||yolo26n-int8|browser|m|camera||environment";
const TICK = 2000;
const HEARTBEAT = 5 * 60 * 1000;

// A 64x48 luma frame: flat grey, optionally with a bright block covering
// `fraction` of it — enough local change to clear every motion preset.
function frame(fraction = 0, level = 120) {
  const g = new Uint8ClampedArray(N).fill(level);
  for (let i = 0; i < Math.round(N * fraction); i++) g[i] = 240;
  return g;
}
const EMPTY = frame(0);
const PERSON_IN = frame(0.15);

const COUCH = det("couch", 0.7, [0.3, 0.8, 0.4, 0.2]);
const PERSON = det("person", 0.85, [0.6, 0.5]);

// Drive one tick exactly as useMonitor does, with a scripted detector. Returns
// the decision plus whether the detector was actually consulted, so tests can
// assert on GPU work as well as on outcomes.
function tick(state, { now, gray, detections, fail = false, wakeOn = "added,removed", promptContext = false }) {
  const begin = beginTick(state, { now, signature: SIG, heartbeatMs: HEARTBEAT });
  if (begin.decided) return { ...begin, detectorRan: false };
  const motion = afterMotion(state, { gray, preset: PRESET, heartbeatDue: begin.heartbeatDue });
  if (motion.decided) return { ...motion, detectorRan: false };
  if (fail) return { ...detectFailed(state, { now }), detectorRan: true };
  return {
    ...afterDetect(state, {
      detections,
      opts: OPTS,
      wakeOn,
      heartbeatDue: begin.heartbeatDue,
      promptContext,
    }),
    detectorRan: true,
  };
}

// A person walks in (two sightings: enterFrames is 2), the gate passes, and
// the VLM scans that frame. Returns the clock after the scan.
function arriveAndScan(state, t) {
  tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  const arrived = tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  assert.equal(arrived.why, "added person");
  scanCompleted(state, { now: t, gray: PERSON_IN });
  return t;
}

// An armed session that has completed its baseline scan on an empty room
// with a couch in it — the starting point for most scenarios below.
function armedOnEmptyRoom(t0 = 1_000_000) {
  _resetTrackIds();
  const state = createGateState();
  const first = tick(state, { now: t0, gray: EMPTY, detections: [COUCH] });
  assert.equal(first.why, "baseline");
  // The baseline scan runs, then the inventory is seeded from that frame.
  scanCompleted(state, { now: t0, gray: EMPTY });
  seedFrom(state, [COUCH]);
  return { state, t: t0 };
}

// --- cold start -------------------------------------------------------------

test("the first tick of a session is a baseline scan, not a gate decision", () => {
  const state = createGateState();
  const d = tick(state, { now: 0, gray: EMPTY, detections: [] });
  assert.equal(d.pass, true);
  assert.equal(d.why, "baseline");
  assert.equal(d.detectorRan, false);
});

test("a baseline whose scan never completed is retried, not assumed", () => {
  const state = createGateState();
  tick(state, { now: 0, gray: EMPTY, detections: [] });
  // No scanCompleted() — the provider errored. The next tick must baseline
  // again rather than start diffing against a scene nothing ever judged.
  const again = tick(state, { now: TICK, gray: EMPTY, detections: [] });
  assert.equal(again.why, "baseline");
});

test("furniture seeded at baseline never emits 'added'", () => {
  let { state, t } = armedOnEmptyRoom();
  // Even with motion forcing the detector to look, the couch is not news.
  for (let i = 1; i <= 5; i++) {
    const d = tick(state, { now: t + i * TICK, gray: frame(0.1), detections: [COUCH] });
    assert.equal(d.pass, false, `tick ${i}`);
  }
  assert.equal(state.objects, "couch x1");
});

test("seedFrom is a no-op once the inventory has been seeded", () => {
  const { state } = armedOnEmptyRoom();
  assert.equal(seedFrom(state, [PERSON]), false);
  assert.equal(state.objects, "couch x1");
});

// --- the steady state ---------------------------------------------------------

test("a still room skips the detector entirely", () => {
  let { state, t } = armedOnEmptyRoom();
  let detectorRuns = 0;
  for (let i = 1; i <= 100; i++) {
    const d = tick(state, { now: t + i * TICK, gray: EMPTY, detections: [COUCH] });
    assert.equal(d.pass, false);
    if (d.detectorRan) detectorRuns++;
  }
  assert.equal(detectorRuns, 0, "stage 0 must keep a still scene off the GPU");
  assert.equal(state.skips, 100);
});

test("a person walking in wakes the VLM once, after enterFrames", () => {
  let { state, t } = armedOnEmptyRoom();
  const seen = [];
  for (let i = 1; i <= 4; i++) {
    const d = tick(state, { now: t + i * TICK, gray: PERSON_IN, detections: [COUCH, PERSON] });
    seen.push(d.pass ? d.why : "-");
  }
  // Tick 1 opens a candidate, tick 2 promotes it. Nothing after that until a
  // scan rebases — but the pass on tick 2 is what the caller acts on.
  assert.deepEqual(seen.slice(0, 2), ["-", "added person"]);
});

test("REGRESSION: a person who walks in and then stands still is still reported", () => {
  // The bug the absorbing fix below first introduced: tick 1 sees the person
  // as a candidate and (finding nothing to report yet) rebased the motion
  // reference onto that frame, so tick 2's identical frame read as "still",
  // the detector never looked again, and the candidate was stranded — a
  // false negative. Stage 0 must not skip while a track is unsettled.
  let { state, t } = armedOnEmptyRoom();
  const standing = frame(0.15);
  const seen = [];
  for (let i = 1; i <= 3; i++) {
    const d = tick(state, { now: t + i * TICK, gray: standing, detections: [COUCH, PERSON] });
    seen.push({ why: d.pass ? d.why : "-", ran: d.detectorRan });
  }
  assert.deepEqual(seen[0], { why: "-", ran: true }, "first sighting: candidate");
  assert.deepEqual(seen[1], { why: "added person", ran: true }, "second sighting confirms");
});

test("a person leaving wakes the VLM once, after exitFrames — the detector keeps looking", () => {
  let { state, t } = armedOnEmptyRoom();
  t = arriveAndScan(state, t);
  // The empty frame then holds still, but the fading track keeps stage 0
  // from skipping until the departure is confirmed.
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const d = tick(state, { now: (t += TICK), gray: EMPTY, detections: [COUCH] });
    seen.push(d.pass ? d.why : d.detectorRan ? "looked" : "skipped");
  }
  assert.deepEqual(seen.slice(0, 3), ["looked", "looked", "removed person"]);
});

test("REGRESSION: a persistent non-object change stops costing a detector pass", () => {
  // A lamp switched on in one corner: a real local change, but not an object.
  // Before the fix the stage 0 reference stayed pinned to the last *scanned*
  // frame, so this ran the detector on every tick until the heartbeat.
  let { state, t } = armedOnEmptyRoom();
  const lampOn = frame(0.2, 120);
  const runs = [];
  for (let i = 1; i <= 10; i++) {
    const d = tick(state, { now: t + i * TICK, gray: lampOn, detections: [COUCH] });
    assert.equal(d.pass, false);
    runs.push(d.detectorRan);
  }
  assert.deepEqual(
    runs,
    [true, false, false, false, false, false, false, false, false, false],
    "one detector pass to confirm nothing changed, then stage 0 absorbs it",
  );
});

// --- cadence, heartbeat, rebaseline -------------------------------------------

test("a pass deferred by the cadence floor is still owed on the next tick", () => {
  let { state, t } = armedOnEmptyRoom();
  tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  const d = tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  assert.equal(d.why, "added person");
  // The mode says it's too soon to scan. The caller defers…
  defer(state, d);
  // …and the next tick scans without needing the (already consumed) event,
  // even though nothing new happens and the detector is not consulted.
  const owed = tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  assert.equal(owed.pass, true);
  assert.equal(owed.why, "added person");
  assert.equal(owed.detectorRan, false);
  scanCompleted(state, { now: t });
  const after = tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  assert.equal(after.pass, false, "the debt is cleared by the scan");
});

test("the heartbeat forces a scan on a still scene, then re-arms", () => {
  let { state, t } = armedOnEmptyRoom();
  const passes = [];
  const end = t + 2 * HEARTBEAT + TICK;
  for (let now = t + TICK; now <= end; now += TICK) {
    const d = tick(state, { now, gray: EMPTY, detections: [COUCH] });
    if (d.pass) {
      passes.push({ now, why: d.why });
      scanCompleted(state, { now });
    }
  }
  assert.deepEqual(
    passes.map((p) => p.why),
    ["heartbeat", "heartbeat"],
  );
  assert.equal(passes[0].now - t, HEARTBEAT);
});

test("a heartbeat of 0 disables it (and a still scene then never scans)", () => {
  let { state, t } = armedOnEmptyRoom();
  for (let i = 1; i <= 400; i++) {
    const begin = beginTick(state, { now: t + i * TICK, signature: SIG, heartbeatMs: 0 });
    if (begin.decided) assert.fail(`tick ${i} decided ${begin.why}`);
    const m = afterMotion(state, { gray: EMPTY, preset: PRESET, heartbeatDue: begin.heartbeatDue });
    assert.equal(m.decided && m.pass, false);
  }
});

test("changing the camera or mission re-baselines and drops the inventory", () => {
  let { state, t } = armedOnEmptyRoom();
  const d = beginTick(state, { now: t + TICK, signature: SIG + "|front", heartbeatMs: HEARTBEAT });
  assert.equal(d.why, "baseline");
  assert.deepEqual(state.tracks, []);
  assert.equal(state.seedNext, true);
  assert.equal(state.refGray, null);
});

test("MOVED only wakes when asked, and only once per scan", () => {
  let { state, t } = armedOnEmptyRoom();
  t = arriveAndScan(state, t);
  const walked = det("person", 0.85, [0.85, 0.5]);
  const off = tick(state, { now: (t += TICK), gray: frame(0.3), detections: [COUCH, walked] });
  assert.equal(off.pass, false, "moved is off by default");

  ({ state, t } = armedOnEmptyRoom());
  t = arriveAndScan(state, t);
  const wakeOn = "added,removed,moved";
  const on = tick(state, { now: (t += TICK), gray: frame(0.3), detections: [COUCH, walked], wakeOn });
  assert.equal(on.why, "moved person");
  const again = tick(state, { now: (t += TICK), gray: frame(0.35), detections: [COUCH, walked], wakeOn });
  assert.equal(again.pass, false, "already reported until the next scan");
});

test("the scene hint rides along only when asked for", () => {
  let { state, t } = armedOnEmptyRoom();
  tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON], promptContext: true });
  const d = tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON], promptContext: true });
  assert.match(d.hint, /couch x1/);
  assert.match(d.hint, /New since the last check: person/);

  ({ state, t } = armedOnEmptyRoom());
  tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  const quiet = tick(state, { now: (t += TICK), gray: PERSON_IN, detections: [COUCH, PERSON] });
  assert.equal(quiet.hint, "");
});

// --- a detector that won't cooperate ----------------------------------------

test("REGRESSION: a failing detector backs off instead of retrying every tick", () => {
  let { state, t } = armedOnEmptyRoom();
  let attempts = 0;
  // Offline first run: every detector attempt fails. The scene alternates so
  // every tick is real motion — the worst case, where stage 0 never helps.
  let i = 0;
  for (let now = t + TICK; now <= t + 10 * 60 * 1000; now += TICK) {
    const gray = i++ % 2 ? EMPTY : frame(0.3);
    const d = tick(state, { now, gray, fail: true });
    // Motion with no working detector must scan: a broken gate must never
    // silence the monitor. (Backoff ticks scan too — see beginTick.)
    assert.equal(d.pass, true, `tick at ${now - t}ms: ${d.why}`);
    if (d.detectorRan) attempts++;
    scanCompleted(state, { now, gray });
  }
  // 5 s, 10 s, 20 s … capped at 5 min: a handful of attempts, not 300.
  assert.ok(attempts <= 8, `detector attempted ${attempts} times`);
  assert.ok(attempts >= 4, `detector attempted ${attempts} times — retries should continue`);
});

test("REGRESSION: the motion reference is the frame the VLM scanned, not an older one", () => {
  // A tick that decides early (here: detector backoff) never runs stage 0,
  // so it never grabs a frame. Rebasing onto "the last stage-0 frame" then
  // pinned the reference to a scene from before the scan — and a room that
  // returned to that old look read as "still", skipping the detector while a
  // person had in fact just left.
  let { state, t } = armedOnEmptyRoom();
  tick(state, { now: (t += TICK), gray: EMPTY, detections: [COUCH] }); // stage 0 saw EMPTY
  detectFailed(state, { now: t }); // the detector is backing off for 5 s
  const during = tick(state, { now: (t += 1000), gray: PERSON_IN, fail: true });
  assert.equal(during.why, "gate unavailable");
  scanCompleted(state, { now: t, gray: PERSON_IN }); // the VLM scanned the person
  t += DETECT_RETRY_BASE_MS;
  const after = tick(state, { now: t, gray: EMPTY, detections: [COUCH] });
  assert.equal(after.detectorRan, true, "EMPTY differs from what was scanned — look");
});

test("the backoff doubles, caps, and resets on the first success", () => {
  const state = createGateState();
  let now = 0;
  const delays = [];
  for (let i = 0; i < 10; i++) {
    detectFailed(state, { now });
    delays.push(state.detectRetryAt - now);
  }
  assert.deepEqual(delays.slice(0, 4), [5000, 10000, 20000, 40000].map((x) => x * DETECT_RETRY_BASE_MS / 5000));
  assert.equal(Math.max(...delays), DETECT_RETRY_MAX_MS);
  afterDetect(state, { detections: [], opts: OPTS, wakeOn: "added" });
  assert.equal(state.detectFailures, 0);
  assert.equal(state.detectRetryAt, 0);
});

// --- the invariant ------------------------------------------------------------

test("INVARIANT: over a long random session, no gap between scans exceeds the heartbeat", () => {
  // Seeded LCG so a failure reproduces.
  let seed = 0x5eed;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  _resetTrackIds();
  const state = createGateState();
  let lastScan = null;
  let maxGap = 0;
  let scans = 0;
  let ticks = 0;
  const hours = 6;
  for (let now = 0; now < hours * 3600e3; now += TICK) {
    ticks++;
    const r = rand();
    // A scene that is mostly still, with people, furniture shuffles, lighting
    // changes and detector failures sprinkled through it.
    const gray = r < 0.85 ? EMPTY : frame(rand() * 0.4, 100 + Math.floor(rand() * 60));
    const detections = [COUCH];
    if (rand() < 0.1) detections.push(det("person", 0.3 + rand() * 0.6, [rand(), rand()]));
    if (rand() < 0.05) detections.push(det("dog", 0.5, [rand(), 0.8]));
    const d = tick(state, { now, gray, detections, fail: rand() < 0.02 });
    // Model the cadence floor: 5 s between scans.
    if (d.pass && lastScan != null && now - lastScan < 5000) {
      defer(state, d);
      continue;
    }
    if (d.pass) {
      if (lastScan != null) maxGap = Math.max(maxGap, now - lastScan);
      lastScan = now;
      scans++;
      scanCompleted(state, { now, gray });
      if (state.seedNext) seedFrom(state, detections);
    }
  }
  assert.ok(
    maxGap <= HEARTBEAT + TICK,
    `longest silence was ${(maxGap / 60e3).toFixed(1)} min; the heartbeat is ${HEARTBEAT / 60e3} min`,
  );
  // And the gate is actually doing its job: far fewer scans than ticks.
  assert.ok(scans < ticks / 5, `${scans} scans in ${ticks} ticks`);
});
