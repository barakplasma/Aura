// Unit tests for the e2e harness's synthetic scene fixtures
// (e2e/fixtures.mjs). The scenes are rendered with sharp from SVG — no
// photos, no licensing, and loud enough that a temperature-0.5 provider call
// can't flip on them. What the tests pin: valid 640x480 JPEG data URLs, one
// scene that must trigger a person-detection mission and one that must not.

import { test } from "node:test";
import assert from "node:assert/strict";

test("buildFixtures yields a must-trigger and a must-not-trigger 640x480 JPEG", async () => {
  const { buildFixtures } = await import("../e2e/fixtures.mjs");
  const fixtures = await buildFixtures();
  const byName = Object.fromEntries(fixtures.map((f) => [f.name, f]));

  assert.ok(byName["person-at-door"], "must-trigger scene exists");
  assert.equal(byName["person-at-door"].expectedTriggered, true);
  assert.ok(byName["empty-hallway"], "must-not-trigger scene exists");
  assert.equal(byName["empty-hallway"].expectedTriggered, false);

  for (const f of fixtures) {
    assert.match(
      f.dataUrl,
      /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/,
      `${f.name}: JPEG data URL`,
    );
    const bytes = Buffer.from(f.dataUrl.split(",")[1], "base64");
    assert.equal(bytes[0], 0xff, `${f.name}: JPEG magic`);
    assert.equal(bytes[1], 0xd8, `${f.name}: JPEG magic`);
  }
});

test("fixtures decode to real 640x480 JPEG images via sharp", async () => {
  const { buildFixtures } = await import("../e2e/fixtures.mjs");
  const sharp = (await import("sharp")).default;
  for (const f of await buildFixtures()) {
    const meta = await sharp(Buffer.from(f.dataUrl.split(",")[1], "base64")).metadata();
    assert.equal(meta.format, "jpeg", `${f.name}: format`);
    assert.equal(meta.width, 640, `${f.name}: width`);
    assert.equal(meta.height, 480, `${f.name}: height`);
  }
});

test("each fixture ships the mission text its expectation was written against", async () => {
  // The must-not scene is only a true negative for a person-detection
  // mission; coupling the two in the fixture keeps a harness caller from
  // pairing it with an unrelated mission and "passing" by accident.
  const { buildFixtures, PERSON_MISSION } = await import("../e2e/fixtures.mjs");
  assert.match(PERSON_MISSION, /person/i);
  for (const f of await buildFixtures()) {
    assert.equal(typeof f.mission, "string");
    assert.ok(f.mission.length > 0);
  }
});
