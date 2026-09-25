// Shared fixtures for the object-gate tests (object-gate, gate-session).
// No tests live here; `node --test` loads it like any file under test/ and
// reports nothing.

import { COCO_LABELS } from "../lib/detector-models.js";

// A detection as stepTracks() consumes it: a COCO label, a score, and a box
// given as centre + size, returned as normalized x1, y1, x2, y2.
export function det(label, score, [x, y, w = 0.1, h = 0.2]) {
  return {
    classId: COCO_LABELS.indexOf(label),
    label,
    score,
    box: [x - w / 2, y - h / 2, x + w / 2, y + h / 2],
  };
}
