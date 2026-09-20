// Synthetic scene fixtures for the e2e harness — sharp-rendered SVG → JPEG
// at the app's capture size (640x480). Real photos would be nicer input but
// bring licensing, download flakiness, and ambiguity; these scenes are
// deliberately loud: a backlit human silhouette in an open doorway vs. the
// same hallway with the door shut. A temperature-0.5 cloud call or a 0.8B
// in-browser model should never sit on the fence between them.
//
// Pairing each fixture with the mission it was drawn for (PERSON_MISSION)
// keeps the harness honest: the empty scene is only a true negative for a
// person-detection mission, so that pairing is the fixture's, not the
// caller's, responsibility.

import sharp from "sharp";

export const PERSON_MISSION =
  "Alert when a person or human figure is visible at the entrance.";

const W = 640;
const H = 480;

// Shared shell: wall gradient, floor, skirting line. The two scenes differ
// only in what the doorway shows, so background cues can't carry a trigger.
const shell = `
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#b8b2a7"/>
      <stop offset="1" stop-color="#8f887c"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f5f1e6"/>
      <stop offset="1" stop-color="#d8d2c4"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#wall)"/>
  <rect y="400" width="${W}" height="80" fill="#6e685e"/>
  <rect y="396" width="${W}" height="6" fill="#57524a"/>
`;

function doorway(x, width, inner) {
  return `
  <rect x="${x - 14}" y="90" width="${width + 28}" height="310" fill="#4a453d"/>
  <rect x="${x}" y="100" width="${width}" height="300" fill="${inner}"/>
  `;
}

const personSilhouette = `
  <circle cx="368" cy="190" r="34" fill="#16130f"/>
  <path d="M 322 400
           L 322 268
           Q 322 232 368 232
           Q 414 232 414 268
           L 414 400 Z"
        fill="#16130f"/>
`;

async function sceneToJpegDataUrl(svg) {
  const jpeg = await sharp(Buffer.from(svg))
    .jpeg({ quality: 90 })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

export async function buildFixtures() {
  const personAtDoor = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${shell}
    ${doorway(300, 136, "url(#glow)")}
    ${personSilhouette}
  </svg>`;

  const emptyHallway = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    ${shell}
    ${doorway(300, 136, "#7d766a")}
    <rect x="316" y="116" width="104" height="268" fill="#948c7e"/>
    <circle cx="404" cy="250" r="6" fill="#57524a"/>
  </svg>`;

  return [
    {
      name: "person-at-door",
      expectedTriggered: true,
      mission: PERSON_MISSION,
      dataUrl: await sceneToJpegDataUrl(personAtDoor),
    },
    {
      name: "empty-hallway",
      expectedTriggered: false,
      mission: PERSON_MISSION,
      dataUrl: await sceneToJpegDataUrl(emptyHallway),
    },
  ];
}
