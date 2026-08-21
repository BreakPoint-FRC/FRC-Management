// Generates the PWA icon set into public/icons/ with no image dependencies.
//
// The mark is a debugger breakpoint dot on a dark rounded square — apt for an
// app called BreakPoint, and legible down to favicon size. Re-run after editing
// COLORS:  node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

const COLORS = {
  background: [0x0f, 0x17, 0x2a], // slate-900
  dot: [0xef, 0x44, 0x44], // red-500
};

const SUPERSAMPLE = 4; // 4x4 samples per pixel for smooth edges

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12 stay 0: deflate, adaptive filtering, no interlace

  // Each scanline is prefixed with filter type 0 (None).
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- Shapes -----------------------------------------------------------------

function insideRoundedSquare(x, y, size, radius) {
  const max = size - radius;
  const cx = x < radius ? radius : x > max ? max : x;
  const cy = y < radius ? radius : y > max ? max : y;
  if (x === cx && y === cy) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insideCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * @param size      output edge length in px
 * @param dotRatio  dot radius as a fraction of size
 * @param cornerRatio corner radius as a fraction of size (0 = full bleed square,
 *                  which is what maskable and iOS icons need since the platform
 *                  applies its own mask)
 */
function renderIcon(size, dotRatio, cornerRatio) {
  const rgba = Buffer.alloc(size * size * 4);
  const corner = cornerRatio * size;
  const centre = size / 2;
  const dotRadius = dotRatio * size;
  const step = 1 / SUPERSAMPLE;
  const samplesPerPixel = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let dotHits = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          if (corner === 0 || insideRoundedSquare(px, py, size, corner)) bgHits++;
          if (insideCircle(px, py, centre, centre, dotRadius)) dotHits++;
        }
      }

      const bgAlpha = bgHits / samplesPerPixel;
      const dotAlpha = dotHits / samplesPerPixel;
      const offset = (y * size + x) * 4;

      // Composite dot over background, then the whole thing over transparency.
      for (let c = 0; c < 3; c++) {
        rgba[offset + c] = Math.round(
          COLORS.background[c] * (1 - dotAlpha) + COLORS.dot[c] * dotAlpha
        );
      }
      rgba[offset + 3] = Math.round(255 * Math.max(bgAlpha, dotAlpha * bgAlpha));
    }
  }

  return encodePng(size, size, rgba);
}

// --- Output -----------------------------------------------------------------

const ICONS = [
  // Chrome requires both 192 and 512 for installability.
  { file: "icon-192.png", size: 192, dot: 0.26, corner: 0.22 },
  { file: "icon-512.png", size: 512, dot: 0.26, corner: 0.22 },
  // Maskable: full bleed, content inside the centre 80% safe zone.
  { file: "icon-maskable-512.png", size: 512, dot: 0.2, corner: 0 },
  // iOS applies its own rounding, so ship a square.
  { file: "apple-touch-icon.png", size: 180, dot: 0.28, corner: 0 },
  { file: "favicon-32.png", size: 32, dot: 0.3, corner: 0 },
];

mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, dot, corner } of ICONS) {
  const png = renderIcon(size, dot, corner);
  writeFileSync(join(OUT_DIR, file), png);
  console.log(`${file.padEnd(24)} ${size}x${size}  ${png.length} bytes`);
}
