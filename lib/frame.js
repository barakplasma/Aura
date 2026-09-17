// Capture sizes are intentionally small, fixed presets: vision providers often
// bill by image dimensions rather than JPEG bytes, and unknown saved values
// must preserve Aura's historical 640×480 behavior.
const CAPTURE_SIZES = {
  "640x480": { width: 640, height: 480 },
  "512x384": { width: 512, height: 384 },
  "320x240": { width: 320, height: 240 },
};

export function normalizeCaptureSize(size) {
  return CAPTURE_SIZES[size] || CAPTURE_SIZES["640x480"];
}
