// Capture sizes are intentionally small, fixed presets: vision providers often
// bill by image dimensions rather than JPEG bytes, and unknown saved values
// must preserve Aura's historical 640×480 behavior.
const DEFAULT_CAPTURE_SIZE = { width: 640, height: 480 };
const MIN_DIMENSION = 64;
const MAX_DIMENSION = 4096;
const MAX_PIXELS = 8_294_400;
const CAPTURE_SIZES = {
  "640x480": { width: 640, height: 480 },
  "512x384": { width: 512, height: 384 },
  "320x240": { width: 320, height: 240 },
};

export function normalizeCaptureSize(size) {
  if (CAPTURE_SIZES[size]) return CAPTURE_SIZES[size];
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(String(size));
  if (!match) return DEFAULT_CAPTURE_SIZE;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (
    width < MIN_DIMENSION ||
    height < MIN_DIMENSION ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  )
    return DEFAULT_CAPTURE_SIZE;
  return { width, height };
}
