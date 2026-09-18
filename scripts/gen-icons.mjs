#!/usr/bin/env node
/**
 * Generates the PWA icon set as PNGs.
 *
 * Icons are built rather than committed: they are derived art, and keeping
 * binaries out of the tree keeps the "no media files committed" rule simple to
 * enforce (.gitignore blocks *.png outright).
 *
 * A minimal PNG writer is used so the build needs no native image dependency.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'icons');

const BG = [0x0a, 0x0a, 0x0a];
const FG = [0x00, 0xff, 0x00];

function crc32(buf) {
  let c;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark is an "@" drawn as a coarse pixel grid — the same character the
 * favicon uses, rendered without a font so the build stays dependency-free.
 */
const GLYPH = [
  '..#######..',
  '.#.......#.',
  '#..#####..#',
  '#.#.....#.#',
  '#.#.###.#.#',
  '#.#.#.#.#.#',
  '#.#.###.#.#',
  '#.#.......#',
  '#..#####.#.',
  '.#........#',
  '..#######..',
];

function render(size, padding) {
  const rgb = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    rgb[i * 3] = BG[0];
    rgb[i * 3 + 1] = BG[1];
    rgb[i * 3 + 2] = BG[2];
  }
  const cols = GLYPH[0].length;
  const rows = GLYPH.length;
  const inner = size * (1 - padding * 2);
  const cell = Math.floor(inner / Math.max(cols, rows));
  const offX = Math.floor((size - cell * cols) / 2);
  const offY = Math.floor((size - cell * rows) / 2);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      if (GLYPH[gy][gx] !== '#') continue;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const px = offX + gx * cell + x;
          const py = offY + gy * cell + y;
          if (px < 0 || px >= size || py < 0 || py >= size) continue;
          const i = (py * size + px) * 3;
          rgb[i] = FG[0];
          rgb[i + 1] = FG[1];
          rgb[i + 2] = FG[2];
        }
      }
    }
  }
  return encodePng(size, size, rgb);
}

mkdirSync(outDir, { recursive: true });

const targets = [
  ['icon-192.png', 192, 0.12],
  ['icon-512.png', 512, 0.12],
  // Maskable icons need their content inside the safe zone (80% of the canvas).
  ['maskable-512.png', 512, 0.22],
  ['apple-touch-icon.png', 180, 0.14],
];

for (const [name, size, padding] of targets) {
  writeFileSync(resolve(outDir, name), render(size, padding));
  process.stdout.write(`icons: ${name} (${size}x${size})\n`);
}
