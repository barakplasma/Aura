import test from "node:test";
import assert from "node:assert/strict";
import {
  DETECTOR_MODELS,
  DEFAULT_DETECTOR_MODEL,
  detectorModelKeys,
  getDetectorModel,
  pickDetectorModel,
  suggestClasses,
  parseClassFilter,
  COCO_LABELS,
} from "../lib/detector-models.js";

test("every row carries what the worker needs to load it", () => {
  for (const [key, cfg] of Object.entries(DETECTOR_MODELS)) {
    assert.ok(cfg.modelId, `${key} has a repo`);
    assert.ok(cfg.dtype, `${key} has a dtype`);
    assert.equal(cfg.inputSize, 640, `${key} matches the export's fixed dims`);
    assert.ok(cfg.downloadBytes > 0, `${key} has a size`);
    assert.equal(typeof cfg.autoSelectable, "boolean");
  }
  assert.ok(DETECTOR_MODELS[DEFAULT_DETECTOR_MODEL], "the default exists");
});

test("detectorModelKeys sorts by download size", () => {
  const keys = detectorModelKeys();
  const sizes = keys.map((k) => DETECTOR_MODELS[k].downloadBytes);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => a - b));
});

test("getDetectorModel never throws on unknown input", () => {
  assert.equal(getDetectorModel("nope"), null);
  assert.equal(getDetectorModel(undefined), null);
  assert.ok(getDetectorModel(DEFAULT_DETECTOR_MODEL));
});

test("pickDetectorModel prefers fp16 on WebGPU and int8 without it", () => {
  assert.equal(pickDetectorModel({ hasWebGpu: true }), "yolo26n-fp16");
  assert.equal(pickDetectorModel({ hasWebGpu: false }), "yolo26n-int8");
  // An empty probe is the "we could not tell" case: assume no WebGPU, which
  // picks the row that runs acceptably on either backend.
  assert.equal(pickDetectorModel({}), "yolo26n-int8");
  assert.ok(DETECTOR_MODELS[pickDetectorModel({ hasWebGpu: true })].requiresWebGpu);
});

test("COCO_LABELS is the 80-class list in index order", () => {
  assert.equal(COCO_LABELS.length, 80);
  assert.equal(COCO_LABELS[0], "person");
  assert.equal(COCO_LABELS[79], "toothbrush");
  assert.equal(new Set(COCO_LABELS).size, 80, "no duplicates");
});

test("suggestClasses maps mission language onto COCO classes", () => {
  assert.deepEqual(suggestClasses("a person at the front door"), ["person"]);
  const parcel = suggestClasses("a parcel left on the doorstep");
  assert.ok(parcel.includes("backpack") && parcel.includes("suitcase"));
  const pets = suggestClasses("the cat is on the kitchen counter");
  assert.ok(pets.includes("cat"));
  assert.ok(suggestClasses("any vehicle in the driveway").includes("car"));
});

test("suggestClasses does not match substrings of other words", () => {
  assert.deepEqual(suggestClasses("the carpet needs cleaning"), []);
  assert.deepEqual(suggestClasses("he has a beard"), []);
  // Plurals do match — operators write "people" and "cars".
  assert.ok(suggestClasses("cars in the street").includes("car"));
});

test("suggestClasses returns nothing for a mission with no COCO noun", () => {
  assert.deepEqual(suggestClasses("the stove was left on"), []);
  assert.deepEqual(suggestClasses(""), []);
  assert.deepEqual(suggestClasses(undefined), []);
});

test("parseClassFilter keeps valid labels and drops the rest", () => {
  assert.deepEqual(parseClassFilter("person, dog"), ["person", "dog"]);
  assert.deepEqual(parseClassFilter("Person\nCAT"), ["person", "cat"]);
  assert.equal(parseClassFilter(""), null, "blank means watch everything");
  assert.equal(parseClassFilter("   "), null);
  assert.equal(
    parseClassFilter("dragon, unicorn"),
    null,
    "an all-invalid list must not silently filter everything out",
  );
  assert.deepEqual(parseClassFilter("dragon, person"), ["person"]);
});
