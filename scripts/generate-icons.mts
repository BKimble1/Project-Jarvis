#!/usr/bin/env tsx
/**
 * Generates the PWA icon set.
 *
 * Written by hand rather than pulled from a design tool so the icons are reproducible from the
 * repository alone, with no binary assets of unknown provenance and no image dependency.
 * The mark is a simple "J" on the Jarvis accent colour.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type RGBA = [number, number, number, number];

const ACCENT: RGBA = [0x3f, 0x51, 0xb5, 255];
const ACCENT_DARK: RGBA = [0x30, 0x3f, 0x9f, 255];
const GLYPH: RGBA = [0xf5, 0xf6, 0xfa, 255];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(width: number, height: number, pixels: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of a pixel by a shape, sampled 3x3 for cheap anti-aliasing. */
function coverage(x: number, y: number, inside: (px: number, py: number) => boolean): number {
  let hits = 0;
  for (let sy = 0; sy < 3; sy += 1) {
    for (let sx = 0; sx < 3; sx += 1) {
      if (inside(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3)) hits += 1;
    }
  }
  return hits / 9;
}

function blend(target: Uint8Array, index: number, colour: RGBA, alpha: number): void {
  if (alpha <= 0) return;
  const inverse = 1 - alpha;
  target[index] = Math.round((target[index] ?? 0) * inverse + colour[0] * alpha);
  target[index + 1] = Math.round((target[index + 1] ?? 0) * inverse + colour[1] * alpha);
  target[index + 2] = Math.round((target[index + 2] ?? 0) * inverse + colour[2] * alpha);
  target[index + 3] = Math.max(target[index + 3] ?? 0, Math.round(colour[3] * alpha));
}

function renderIcon(size: number, options: { maskable: boolean }): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const radius = options.maskable ? size / 2 : size * 0.22;
  const pad = options.maskable ? size * 0.14 : size * 0.2;

  const inSquare = (px: number, py: number): boolean => {
    if (options.maskable) return true;
    const cx = Math.min(Math.max(px, radius), size - radius);
    const cy = Math.min(Math.max(py, radius), size - radius);
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
  };

  /* Glyph geometry: a vertical stem with a hook, i.e. a "J". */
  const stroke = size * 0.13;
  const stemX = size * 0.63;
  const top = pad;
  const hookRadius = size * 0.19;
  const hookCentreY = size - pad - hookRadius;
  /* The arc is centred a radius to the LEFT of the stem, so it starts exactly at the stem's foot. */
  const hookCentreX = stemX - hookRadius;

  const inGlyph = (px: number, py: number): boolean => {
    if (px >= stemX - stroke / 2 && px <= stemX + stroke / 2 && py >= top && py <= hookCentreY)
      return true;
    const dx = px - hookCentreX;
    const dy = py - hookCentreY;
    if (dy < 0) return false;
    const distance = Math.sqrt(dx * dx + dy * dy);
    return distance >= hookRadius - stroke / 2 && distance <= hookRadius + stroke / 2;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const squareAlpha = coverage(x, y, inSquare);
      if (squareAlpha > 0) {
        /* A gentle vertical gradient keeps the mark from looking flat at small sizes. */
        const t = y / size;
        const base: RGBA = [
          Math.round((ACCENT[0] as number) * (1 - t) + (ACCENT_DARK[0] as number) * t),
          Math.round((ACCENT[1] as number) * (1 - t) + (ACCENT_DARK[1] as number) * t),
          Math.round((ACCENT[2] as number) * (1 - t) + (ACCENT_DARK[2] as number) * t),
          255,
        ];
        blend(pixels, index, base, squareAlpha);
      }
      const glyphAlpha = coverage(x, y, inGlyph);
      if (glyphAlpha > 0) blend(pixels, index, GLYPH, glyphAlpha * squareAlpha);
    }
  }
  return pixels;
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Jarvis">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3f51b5"/>
      <stop offset="1" stop-color="#303f9f"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="113" fill="url(#g)"/>
  <path d="M323 102v198a90 90 0 0 1-180 0" fill="none" stroke="#f5f6fa" stroke-width="66" stroke-linecap="round"/>
</svg>
`;

const outDir = path.join(process.cwd(), 'public', 'icons');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'icon.svg'), SVG, 'utf8');

for (const size of [180, 192, 512]) {
  writeFileSync(
    path.join(outDir, `icon-${size}.png`),
    encodePng(size, size, renderIcon(size, { maskable: false })),
  );
}
writeFileSync(
  path.join(outDir, 'icon-maskable-512.png'),
  encodePng(512, 512, renderIcon(512, { maskable: true })),
);

console.log('Icons written to public/icons');
