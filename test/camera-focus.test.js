import { test } from "node:test";
import assert from "node:assert/strict";
import { focusConstraint } from "../lib/camera-focus.js";

// Capabilities read off the reference phone (Pixel 7a, Chrome 153) with the
// environment camera open. The app used to apply none of this, and the driver
// default left a close subject out of focus.
const PHONE = {
  focusMode: ["manual", "single-shot", "continuous"],
  exposureMode: ["continuous", "manual"],
  whiteBalanceMode: ["continuous", "manual"],
  focusDistance: { min: 1, max: 8, step: 0.1 },
};

test("focusConstraint asks for every continuous mode a phone track offers", () => {
  assert.deepEqual(focusConstraint(PHONE), {
    focusMode: "continuous",
    exposureMode: "continuous",
    whiteBalanceMode: "continuous",
  });
});

// Writing a distance takes autofocus out of the loop on Android, and any fixed
// value is a guess about where the subject happens to be.
test("focusConstraint never writes focusDistance", () => {
  assert.ok(!("focusDistance" in focusConstraint(PHONE)));
  assert.ok(!("focusDistance" in focusConstraint({ focusDistance: { min: 1, max: 8 } })));
});

test("focusConstraint falls back to single-shot over a lens frozen at manual", () => {
  assert.deepEqual(
    focusConstraint({ focusMode: ["manual", "single-shot"] }),
    { focusMode: "single-shot" },
  );
});

test("focusConstraint returns nothing for a fixed-focus webcam", () => {
  assert.deepEqual(
    focusConstraint({ focusMode: ["manual"], exposureMode: ["manual"] }),
    {},
  );
  assert.deepEqual(focusConstraint({}), {});
  assert.deepEqual(focusConstraint(), {});
});

// Requesting a mode the driver does not list makes applyConstraints() reject,
// which must not take the camera down.
test("focusConstraint requests only modes the driver actually lists", () => {
  assert.deepEqual(focusConstraint({ focusMode: ["continuous"], exposureMode: [] }), {
    focusMode: "continuous",
  });
  assert.deepEqual(focusConstraint({ exposureMode: ["continuous"] }), {
    exposureMode: "continuous",
  });
});

test("focusConstraint tolerates a driver reporting modes in another case", () => {
  assert.deepEqual(focusConstraint({ focusMode: ["Continuous"] }), {
    focusMode: "continuous",
  });
});

test("focusConstraint survives capabilities that are not arrays", () => {
  assert.deepEqual(focusConstraint({ focusMode: "continuous", exposureMode: null }), {});
});
