// One-time generator for the PWA icons. No image deps — encodes PNGs directly
// with the built-in zlib. Run: node scripts/gen-icons.js
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Draw an "aura": dark rounded background with concentric accent rings.
function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const bg = [11, 11, 20];
  const accent = [79, 140, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy) / (size / 2);
      // Three soft rings glowing toward the center.
      const ring = Math.max(
        0,
        Math.cos((d - 0.15) * Math.PI * 3) * (1 - d)
      );
      const t = Math.min(1, Math.max(0, ring));
      px[i] = Math.round(bg[0] + (accent[0] - bg[0]) * t);
      px[i + 1] = Math.round(bg[1] + (accent[1] - bg[1]) * t);
      px[i + 2] = Math.round(bg[2] + (accent[2] - bg[2]) * t);
      px[i + 3] = 255;
    }
  }
  return px;
}

function encodePng(size) {
  const raw = render(size);
  // Add filter byte (0) at the start of each scanline.
  const stride = size * 4;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    raw.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), encodePng(size));
  console.log(`wrote icon-${size}.png`);
}
