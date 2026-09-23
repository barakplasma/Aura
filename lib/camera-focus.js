// Focus and exposure constraints for phone cameras in a monitoring loop.
//
// getUserMedia returns whatever the driver defaults to, and on the reference
// phone (Pixel 7a, Chrome 153) that default rendered a book held in front of
// the lens as mush — measured as Laplacian variance 736.7 on the live preview,
// and the VLM downstream then had nothing legible to describe. The track does
// support continuous autofocus; nothing in the app ever asked for it:
//
//   focusMode:    ["manual", "single-shot", "continuous"]
//   exposureMode: ["continuous", "manual"]
//
// Everything here is capabilities-gated: asking a driver for a mode it does not
// list makes applyConstraints() reject, and the camera must not go down over a
// focus nicety. Pure so the selection logic is testable without a device.

const lower = (v) => String(v).toLowerCase();

function pick(list, order) {
  const have = Array.isArray(list) ? list.map(lower) : [];
  return order.find((mode) => have.includes(mode));
}

// The constraints to apply to a video track, or {} when the device offers
// nothing worth asking for. `focusDistance` is deliberately never set: writing
// a distance takes autofocus out of the loop on Android, and any fixed value
// is a guess about where the subject happens to be.
export function focusConstraint(caps = {}) {
  const out = {};
  // Continuous is the only mode that keeps up with a subject that moves, which
  // is the whole premise of a monitor. Single-shot still beats a lens frozen at
  // its power-on distance, so it is the fallback rather than nothing.
  const focus = pick(caps.focusMode, ["continuous", "auto", "single-shot"]);
  if (focus) out.focusMode = focus;
  const exposure = pick(caps.exposureMode, ["continuous"]);
  if (exposure) out.exposureMode = exposure;
  const whiteBalance = pick(caps.whiteBalanceMode, ["continuous"]);
  if (whiteBalance) out.whiteBalanceMode = whiteBalance;
  return out;
}
