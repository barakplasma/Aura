// Mirage on this device (the `mirage` DECISION row) — the pure half: asset
// pins, the mission → target step, and the detections → answer step.
//
// Two Cactus models run in one Cactus WASM engine (vendor/cactus/), each in
// its own instance because the engine owns one process-global model:
//   - Needle 3 (text only, 35 MB) reads the mission once and writes the
//     target as a tool call — `watch_for({ object })`.
//   - Mirage (vision, 22 MB) describes every frame: scene + named objects
//     with detection scores, its naming steered by the target as keywords.
//
// Measured in Node on the 4.0.0 WASM build (2026-11-06) before this was
// built: Mirage's yes/no and count *forms* are poorly calibrated (a cat
// photo answered p(cats ≥ 1) = 0.02), but its detector is solid and the
// keywords only change what an object is *called* (cats were "dog" without
// the hint, "cat" with it, and no other photo grew a cat). So the decision
// is "does a detected object carry the target's name", and the confidence
// is that object's detection score.
//
// Plain functions, no Worker or DOM: runs under `node --test`.

import { suggestClasses } from "./detector-models.js";

// Pinned artifacts. The engine ships inside the app (vendor/cactus/, copied
// to public/cactus/ by the build); the weights are fetched once from the
// Hub at a pinned revision and checked against these hashes before use.
const HF = "https://huggingface.co";
export const MIRAGE_ASSETS = {
  engine: {
    path: "cactus/cactus.wasm",
    sha256: "4198b30795ded7739fe6c9e80bf26d5a844767c081574d40c8dc0487cde8b4b6",
    bytes: 1241703,
  },
  vision: {
    url: `${HF}/Cactus-Compute/mirage/resolve/3d03cee88c0acbe4e71b94b567ab14e6e55f40c9/mirage.cact`,
    sha256: "4249a0f7515272ff76b9414bec17d7e7daf84b15b66c7fb4f17fce1e66f9f237",
    bytes: 21611043,
  },
  text: {
    url: `${HF}/Cactus-Compute/needle3/resolve/c95d25b4efa1e9601e785d92438e4ade0dbddbf8/needle3.cact`,
    sha256: "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38",
    bytes: 35335380,
  },
};

// --- Mission → target (Needle 3) -------------------------------------------

export const NEEDLE_SYSTEM = "You set up a home camera alert. Call watch_for with what the camera should look for.";

// `alert_when` is never read: Needle names the object far more reliably when
// the tool also has a direction slot (6/8 missions vs 1/8 without it), but
// its direction was wrong in 2 of those 8, so missionDirection() decides.
export const NEEDLE_TOOLS = [
  {
    type: "function",
    function: {
      name: "watch_for",
      description: "Start watching the camera for something the user cares about.",
      parameters: {
        type: "object",
        properties: {
          object: {
            type: "string",
            description: "The visible object to look for in the frame, as a plain noun: person, dog, package, smoke, car, baby",
          },
          alert_when: { type: "string", enum: ["seen", "not seen"] },
        },
        required: ["object", "alert_when"],
      },
    },
  },
];

// Needle's own answer: the object of its first watch_for call. Needle files
// low-confidence calls under `suppressed_calls`; those are still its best
// reading of the mission, and a wrong-but-plausible noun is caught by the
// suggestClasses() keywords buildTarget() adds, so both lists count.
export function parseNeedleTarget(json) {
  const calls = [
    ...(Array.isArray(json?.function_calls) ? json.function_calls : []),
    ...(Array.isArray(json?.suppressed_calls) ? json.suppressed_calls : []),
  ];
  const call = calls.find((c) => c?.name === "watch_for");
  const object = String(call?.arguments?.object ?? "").trim().toLowerCase();
  // A noun phrase, not a sentence: Needle sometimes echoes the mission back.
  if (!object || object.length > 40 || object.split(/\s+/).length > 4) return null;
  return object;
}

// "alert when it's gone" missions. Deliberately no "left": "a parcel left on
// the doorstep" is an arrival.
const MISSING = /\b(not|no longer|isn'?t|aren'?t|missing|gone|leaves?|leaving|empty|absent|disappears?|without)\b/i;

export function missionDirection(mission) {
  return MISSING.test(String(mission || "")) ? "missing" : "seen";
}

// shortcut: English plurals by suffix only ("people" comes in via suggestClasses' synonyms); fine for nouns a mission names.
function singular(w) {
  if (w.length <= 3 || /(ss|us|is)$/.test(w)) return w;
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(x|ch|sh|ss)es$/.test(w)) return w.slice(0, -2);
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

// The mission's subject: the words before its first place preposition —
// "someone is at the front door" → "someone is". A place is where to look,
// never what to look for: matching "couch" would fire on an empty couch.
const PLACE = /\b(on|in|at|by|near|inside|outside|under|behind|beside|into|onto|across|through|from)\b/i;
function subjectOf(mission) {
  const text = String(mission || "");
  const m = PLACE.exec(text);
  return m ? text.slice(0, m.index) : text;
}

// The target Mirage looks for: the COCO words of the mission's subject (so
// "someone" becomes "person"), plus Needle's noun when it is part of the
// subject too. Needle sometimes names the place instead ("front door"); the
// subject rule drops that. Only when the subject yields nothing do the
// whole mission's words count. With none at all, the mission names nothing
// visible — say so rather than watch for nothing.
export function buildTarget({ mission, needleObject } = {}) {
  const head = ` ${subjectOf(mission).toLowerCase()} `;
  const inHead = (w) => w && String(w).split(/\s+/).every((p) => head.includes(` ${p}`));
  const fromSubject = [...(inHead(needleObject) ? [needleObject, ...suggestClasses(needleObject)] : []), ...suggestClasses(head)];
  const words = fromSubject.length
    ? fromSubject
    : [needleObject, ...suggestClasses(mission), ...(needleObject ? suggestClasses(needleObject) : [])];
  const keywords = [...new Set(words.filter(Boolean).map((w) => singular(String(w).trim().toLowerCase())))].filter(Boolean);
  if (!keywords.length) {
    throw new Error("Couldn't tell what to look for from the mission — name a visible thing, e.g. \"a dog on the couch\".");
  }
  return {
    object: keywords[0],
    keywords,
    alertWhen: missionDirection(mission),
    source: needleObject ? "needle3" : "classes",
  };
}

// --- Frame → answer (Mirage) -----------------------------------------------

// Scene for the announcement, objects for the decision. Masks are left out
// (they're most of the output and nothing here draws them).
export const MIRAGE_OPTIONS = { sections: ["scene", "objects"], max_objects: 16 };

// What Mirage calls a target class that COCO names differently, seen in its
// output: people come back as "rugby player", "man", "crowd".
// shortcut: hand-listed from observed names; extend when Lab › Evaluate shows a miss.
const ALIASES = {
  person: ["man", "woman", "boy", "girl", "child", "kid", "baby", "toddler", "player", "pedestrian", "people", "crowd", "worker", "rider", "skier", "surfer", "skateboarder"],
  cat: ["kitten"],
  dog: ["puppy"],
};

// Whole-word match, plural-tolerant: "soccer ball" matches "ball", "cat"
// matches "cats", "car" does not match "carpet".
export function nameMatches(name, keywords) {
  const words = String(name || "").toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular);
  const phrase = words.join(" ");
  const all = (keywords || []).flatMap((k) => [k, ...(ALIASES[String(k).toLowerCase()] || [])]);
  return all.some((k) => {
    const kw = String(k).toLowerCase().split(/[^a-z]+/).filter(Boolean).map(singular).join(" ");
    return Boolean(kw) && (` ${phrase} `.includes(` ${kw} `) || kw === phrase);
  });
}

// Mirage's scene record as one line: "indoor · pink blanket · soft".
export function describeScene(scene) {
  if (!scene || typeof scene !== "object") return "";
  const order = ["setting", "location", "surface", "background", "lighting", "time_of_day", "weather"];
  // Values can list several things and repeat each other ("parking lot,
  // parking lot, sign"): keep each item once across the whole line.
  const seen = new Set();
  const parts = [];
  for (const k of order) {
    const items = [];
    for (const x of (typeof scene[k] === "string" ? scene[k] : "").split(",").map((v) => v.trim())) {
      if (x && !seen.has(x)) items.push(seen.add(x) && x);
    }
    if (items.length) parts.push(items.join(", "));
  }
  return parts.slice(0, 4).join(" · ");
}

// The decision: p(yes) is the best matching object's detection score
// (missing missions invert it). It is a detection score, not a calibrated
// probability — the row's note says so. `summary` is what the template
// announcement and the provider announcer get as the reason.
export function mirageAnswer(target, out) {
  const objects = Array.isArray(out?.objects) ? out.objects : [];
  let best = null;
  for (const o of objects) {
    if (!Number.isFinite(o?.score) || !nameMatches(o.name, target.keywords)) continue;
    if (!best || o.score > best.score) best = o;
  }
  const seen = best ? best.score : 0;
  const pYes = target.alertWhen === "missing" ? 1 - seen : seen;
  const yes = target.alertWhen === "missing" ? !best : Boolean(best);
  const scene = describeScene(out?.scene);
  const what = best
    ? `${best.name}${best.position ? ` (${best.position})` : ""} seen, score ${best.score.toFixed(2)}`
    : `no ${target.object} in view`;
  return {
    choice: yes ? "yes" : "no",
    probabilities: { yes: pYes, no: 1 - pYes },
    summary: scene ? `${what} — ${scene}` : what,
    objects: objects.map((o) => o?.name).filter(Boolean),
  };
}
