#!/usr/bin/env node
// Renders the pixel-fox mascot concepts from their sprite grids.
//
// The grids in sprites/ are the source. Each character is one pixel:
//
//   .  field (left transparent)   o  fur          d  fur shadow
//   K  outline                    c  cream        t  cream shadow
//   x  nose                       w  eye highlight
//
// 01-reference is a pixel-exact recreation of the reference art, recovered
// from a 15x upscale: the sprite sits on a 28 x 20 grid drawn at 2x, with the
// eye highlights and nose the only marks that use the finer grid.
//
//   node docs/design/mascot-concepts/pixel-fox/render.mjs

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPRITES = path.join(HERE, "sprites");

// Each palette is one ramp: fur, fur shadow, outline, cream, cream shadow, nose.
const ramp = (fur, shadow, line, cream, creamShadow, nose) => ({
  o: fur, d: shadow, K: line, c: cream, t: creamShadow, x: nose, w: "#ffffff"
});

const PALETTES = {
  // 1:1 with the reference art.
  reference: ramp("#c6663a", "#99442d", "#592718", "#ebe1cf", "#bca595", "#110b0f"),
  // The app's warm accent: --accent #a85c43 over --accent-deep #874a36.
  "argmax-warm": ramp("#a85c43", "#874a36", "#3c2119", "#f8e9e1", "#d8bdb0", "#241310"),
  // The violet the app icon and default chrome already carry.
  violet: ramp("#9b6dd4", "#7a4fb5", "#33204f", "#efe9fb", "#c9b5e9", "#1b1029"),
  // Dark-theme tunings: the outline lifts off charcoal instead of vanishing.
  "dark-warm": ramp("#d97757", "#b25a3f", "#5c2f21", "#f3ded2", "#c39a85", "#2a1610"),
  "dark-violet": ramp("#b894ff", "#9068d6", "#4a3170", "#ece2ff", "#bfa6e8", "#231540")
};

const FIELDS = {
  reference: "#fcfcfc",
  "argmax-warm": "#fdfdfd",
  violet: "#fefefe",
  "dark-warm": "#141414",
  "dark-violet": "#1b1b18"
};

const SCALE = 10;

function rgb(hex) {
  return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
}

function readSprite(name) {
  const rows = readFileSync(path.join(SPRITES, name), "utf8").split("\n").filter(Boolean);
  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => row.padEnd(width, "."));
}

function render(rows, palette, field) {
  const width = rows[0].length * SCALE;
  const height = rows.length * SCALE;
  const pixels = Buffer.alloc(width * height * 4);
  const [fr, fg, fb] = rgb(field);
  for (let i = 0; i < width * height; i += 1) {
    pixels.set([fr, fg, fb, 255], i * 4);
  }
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const hex = palette[row.charAt(x)];
      if (!hex) continue;
      const [r, g, b] = rgb(hex);
      for (let dy = 0; dy < SCALE; dy += 1) {
        for (let dx = 0; dx < SCALE; dx += 1) {
          const at = ((y * SCALE + dy) * width + x * SCALE + dx) * 4;
          pixels.set([r, g, b, 255], at);
        }
      }
    }
  });
  return { pixels, width, height };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function chunk(type, body) {
  const framed = Buffer.concat([Buffer.from(type, "ascii"), body]);
  let crc = 0xffffffff;
  for (const byte of framed) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, framed, checksum]);
}

function writePng({ pixels, width, height }, outPath) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha

  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  writeFileSync(
    outPath,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(scanlines, { level: 9 })),
      chunk("IEND", Buffer.alloc(0))
    ])
  );
}

// Every sprite renders in the reference palette; the two headline sprites also
// render in each brand palette so the recolours can be compared side by side.
const RECOLOURED = new Set(["01-reference.txt", "02-head.txt"]);

for (const file of readdirSync(SPRITES).filter((name) => name.endsWith(".txt")).sort()) {
  const rows = readSprite(file);
  const stem = file.replace(/\.txt$/, "");
  const appearances = RECOLOURED.has(file) ? Object.keys(PALETTES) : ["reference"];
  for (const appearance of appearances) {
    const suffix = appearance === "reference" ? "" : `-${appearance}`;
    writePng(render(rows, PALETTES[appearance], FIELDS[appearance]), path.join(HERE, `${stem}${suffix}.png`));
  }
}
