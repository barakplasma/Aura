import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTarget,
  describeScene,
  mirageAnswer,
  missionDirection,
  nameMatches,
  parseNeedleTarget,
} from "../lib/mirage.js";
import { runMirage, _setMirageWorkerFactory } from "../lib/mirage-engine.js";
import { scanDecision } from "../lib/decision.js";
import { DECISION_MODELS, DEFAULT_DECISION_MODEL, isDecisionConfigured } from "../lib/decision-models.js";

const IMAGE = "data:image/jpeg;base64,/9j/AAAA";

// Real engine output (Cactus 4.0.0 WASM, 2026-11-06): Needle 3 on
// "Tell me when a dog is on the couch" — a low-confidence call filed under
// suppressed_calls — and Mirage on a photo of two cats with keywords "cat".
const NEEDLE_DOG = {
  type: "call", success: true, function_calls: [],
  suppressed_calls: [{ name: "watch_for", arguments: { object: "dog", alert_when: "seen" } }],
  confidence: 0.167,
};
const MIRAGE_CATS = {
  scene: { setting: "indoor", surface: "pink blanket", lighting: "soft" },
  objects: [
    { id: 1, name: "tag", score: 0.58 },
    { id: 2, name: "cat", score: 0.717, position: "left" },
    { id: 3, name: "cat", score: 0.686 },
    { id: 4, name: "blanket", score: 0.635 },
  ],
};

test("Needle's watch_for object is read from either call list; sentences are refused", () => {
  assert.equal(parseNeedleTarget(NEEDLE_DOG), "dog");
  assert.equal(parseNeedleTarget({ function_calls: [{ name: "watch_for", arguments: { object: " Baby " } }] }), "baby");
  assert.equal(parseNeedleTarget({ function_calls: [], suppressed_calls: [] }), null);
  assert.equal(parseNeedleTarget({ function_calls: [{ name: "watch_for", arguments: { object: "notify me when someone is at the front door" } }] }), null);
  assert.equal(parseNeedleTarget(null), null);
});

test("direction comes from the mission's words, not from Needle", () => {
  assert.equal(missionDirection("Tell me when a dog is on the couch"), "seen");
  assert.equal(missionDirection("Alert me if the baby is not in the crib"), "missing");
  assert.equal(missionDirection("Tell me if the car leaves the driveway"), "missing");
  assert.equal(missionDirection("the crib is empty"), "missing");
  // An arrival, despite "left".
  assert.equal(missionDirection("a parcel left on the doorstep"), "seen");
});

test("buildTarget keeps the mission's subject and drops the place", () => {
  // Needle named the place; the subject's COCO word wins.
  const t = buildTarget({ mission: "Notify me when someone is at the front door", needleObject: "front door" });
  assert.deepEqual(t.keywords, ["person"]);
  assert.equal(t.alertWhen, "seen");
  assert.equal(t.source, "needle3");
  // "couch" and "bed" are COCO classes too, but they're where to look.
  assert.deepEqual(buildTarget({ mission: "Tell me when a dog is on the couch", needleObject: "dog" }).keywords, ["dog"]);
  assert.deepEqual(buildTarget({ mission: "Tell me if the cat is not on the bed", needleObject: "cat" }).keywords, ["cat"]);
  // A noun COCO doesn't know still comes from Needle.
  assert.deepEqual(buildTarget({ mission: "watch for smoke", needleObject: "smoke" }).keywords, ["smoke"]);
  // Needle down: the mission's own words still make a target.
  const f = buildTarget({ mission: "watch for my cats", needleObject: null });
  assert.deepEqual(f.keywords, ["cat"]);
  assert.equal(f.source, "classes");
  assert.throws(() => buildTarget({ mission: "let me know", needleObject: null }), /name a visible thing/);
});

test("nameMatches is whole-word and plural-tolerant", () => {
  assert.ok(nameMatches("cat", ["cat"]));
  assert.ok(nameMatches("cats", ["cat"]));
  assert.ok(nameMatches("soccer ball", ["ball"]));
  assert.ok(nameMatches("stop sign", ["stop signs"]));
  assert.ok(nameMatches("puppies", ["puppy"]));
  assert.ok(nameMatches("rugby player", ["person"]));
  assert.ok(nameMatches("kitten", ["cat"]));
  assert.ok(!nameMatches("carpet", ["car"]));
  assert.ok(!nameMatches("dog pans", ["cat"]));
  assert.ok(!nameMatches("", ["cat"]));
});

test("mirageAnswer: best matching detection is p(yes); missing missions invert it", () => {
  const seen = mirageAnswer({ object: "cat", keywords: ["cat"], alertWhen: "seen" }, MIRAGE_CATS);
  assert.equal(seen.choice, "yes");
  assert.equal(seen.probabilities.yes, 0.717);
  assert.equal(seen.summary, "cat (left) seen, score 0.72 — indoor · pink blanket · soft");

  const none = mirageAnswer({ object: "dog", keywords: ["dog"], alertWhen: "seen" }, MIRAGE_CATS);
  assert.equal(none.choice, "no");
  assert.equal(none.probabilities.yes, 0);
  assert.match(none.summary, /^no dog in view/);

  const gone = mirageAnswer({ object: "dog", keywords: ["dog"], alertWhen: "missing" }, MIRAGE_CATS);
  assert.equal(gone.choice, "yes");
  assert.equal(gone.probabilities.yes, 1);
  const stillHere = mirageAnswer({ object: "cat", keywords: ["cat"], alertWhen: "missing" }, MIRAGE_CATS);
  assert.equal(stillHere.choice, "no");
  assert.ok(Math.abs(stillHere.probabilities.yes - 0.283) < 1e-9);
});

test("describeScene keeps the first four distinct fields in reading order", () => {
  assert.equal(
    describeScene({ sky: "blue", setting: "parking lot", location: "parking lot", surface: "asphalt", lighting: "daylight", time_of_day: "day" }),
    "parking lot · asphalt · daylight · day",
  );
  // Real output: values that list and repeat items.
  assert.equal(
    describeScene({ setting: "parking lot, parking lot, sign", location: "parking lot, road, sign", surface: "asphalt" }),
    "parking lot, sign · road · asphalt",
  );
  assert.equal(describeScene(null), "");
});

test("mirage is the default decision row and needs no URL or key", () => {
  assert.equal(DEFAULT_DECISION_MODEL, "mirage");
  assert.ok(DECISION_MODELS.mirage.local);
  assert.ok(isDecisionConfigured({ decisionModel: "mirage", decisionUrl: "" }));
});

test("scanDecision on the mirage row: local runner in, scene-worded alert out", async () => {
  const calls = [];
  const res = await scanDecision({
    modelId: "mirage",
    mission: "watch for my cats",
    image: IMAGE,
    threshold: 50,
    action: "Cat alert.",
    requestTimeout: 7,
    localImpl: async (req, opts) => {
      calls.push({ req, opts });
      return { target: buildTarget({ mission: req.mission, needleObject: "cat" }), ...MIRAGE_CATS, timing_ms: { describe: 1900 } };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].req, { image: IMAGE, mission: "watch for my cats" });
  assert.equal(calls[0].opts.timeoutMs, 7000);
  assert.equal(res.triggered, true);
  assert.equal(res.confidence, 72);
  assert.equal(res.reason, "cat (left) seen, score 0.72 — indoor · pink blanket · soft");
  // No announcer: the template speaks the operator's text, then what Mirage saw.
  assert.equal(res.message, "Cat alert. — cat (left) seen, score 0.72 — indoor · pink blanket · soft");
  assert.deepEqual(res.decision.target.keywords, ["cat"]);
  assert.deepEqual(res.timing, { describe: 1900 });
  assert.equal(res.usage.decisions, 1);
});

test("scanDecision on the mirage row: below threshold stays quiet, a runner failure falls back", async () => {
  const quiet = await scanDecision({
    modelId: "mirage", mission: "watch for my cats", image: IMAGE, threshold: 80,
    localImpl: async () => ({ target: buildTarget({ mission: "cats", needleObject: "cat" }), ...MIRAGE_CATS }),
  });
  assert.equal(quiet.triggered, false);

  const res = await scanDecision({
    modelId: "mirage", mission: "watch for my cats", image: IMAGE,
    localImpl: async () => { throw new Error("worker crashed"); },
    fallback: async () => ({ triggered: false, confidence: 0, reason: "provider" }),
  });
  assert.equal(res.reason, "provider");
  assert.equal(res.fallbackReason, "worker crashed");
});

// A fake worker: answers each scan after optional progress messages.
function fakeWorker(script) {
  const w = {
    posted: [],
    terminated: false,
    postMessage(msg) {
      w.posted.push(msg);
      queueMicrotask(() => script(msg, (data) => w.onmessage?.({ data: { id: msg.id, ...data } }), w));
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

test("runMirage: progress is forwarded, the result resolves, errors reject", async (t) => {
  t.after(() => _setMirageWorkerFactory(null));
  const progress = [];
  _setMirageWorkerFactory(() => fakeWorker((msg, reply) => {
    if (msg.mission === "boom") return reply({ type: "result", error: "Mirage failed its integrity check" });
    reply({ type: "progress", phase: "download", file: "Mirage", pct: 40 });
    reply({ type: "progress", phase: "inference" });
    reply({ type: "result", result: { ok: msg.image } });
  }));
  assert.deepEqual(await runMirage({ image: IMAGE, mission: "cats" }, { onProgress: (m) => progress.push(m.phase) }), { ok: IMAGE });
  assert.deepEqual(progress, ["download", "inference"]);
  await assert.rejects(runMirage({ image: IMAGE, mission: "boom" }), /integrity/);
});

test("runMirage: the timeout starts at inference and drops a hung worker", async (t) => {
  t.after(() => _setMirageWorkerFactory(null));
  let worker;
  _setMirageWorkerFactory(() => (worker = fakeWorker((msg, reply) => reply({ type: "progress", phase: "inference" }))));
  await assert.rejects(runMirage({ image: IMAGE, mission: "cats" }, { timeoutMs: 20 }), /longer than 0s/);
  assert.ok(worker.terminated);
});

test("runMirage: an aborted scan rejects at once", async (t) => {
  t.after(() => _setMirageWorkerFactory(null));
  _setMirageWorkerFactory(() => fakeWorker(() => {}));
  const ac = new AbortController();
  const p = runMirage({ image: IMAGE, mission: "cats" }, { signal: ac.signal });
  ac.abort(new Error("stopped"));
  await assert.rejects(p, /stopped/);
});
