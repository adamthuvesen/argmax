#!/usr/bin/env node
// Renders the round-two pixel-fox concepts from their sprite grids.
//
// sprites/*.txt are drawn at 1x on the fox's 28-wide logical grid and expanded
// to the 2x layout assets/fox-mascot.txt uses, so a chosen sprite can be
// promoted by pasting the expanded grid (printed with --expand <name>).
//
//   .  transparent   o  fur     d  fur shadow    K  outline
//   c  cream         t  cream shadow    x  nose  w  eye highlight (full pixel)
//   e  eye pixel: outline top half, highlight bottom half (the shipped fox's eye)
//   p  blush         g  gold    a  motion accent  (mockup-only extras)
//
// A file whose first comment says "scale: 2" is already at 2x and is used as is.
//
//   node docs/design/mascot-concepts/pixel-fox-v2/render.mjs

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPRITES = path.join(HERE, "sprites");

const PALETTE = {
  K: "#592718", o: "#c6663a", d: "#99442d", c: "#ebe1cf", t: "#bca595", x: "#110b0f", w: "#ffffff",
  p: "#e08a78", g: "#e9b949", a: "#6fb7d9"
};
const FIELDS = { light: "#fefefe", dark: "#1b1b18" };

function readSprite(name) {
  const lines = readFileSync(path.join(SPRITES, name), "utf8").split("\n");
  const scale2 = lines.some((line) => line.startsWith("#") && /scale:\s*2/.test(line));
  const rows = lines.filter((row) => row !== "" && !row.startsWith("#"));
  const width = Math.max(...rows.map((row) => row.length));
  for (const [index, row] of rows.entries()) {
    if (row.length !== width) console.warn(`${name}: row ${index} is ${row.length} wide, padded to ${width}`);
    rows[index] = row.padEnd(width, ".");
    for (const ch of rows[index]) if (ch !== "." && !PALETTE[ch] && ch !== "e") throw new Error(`${name}: unknown char ${ch}`);
  }
  return scale2 ? rows : expand(rows);
}

function expand(rows) {
  const out = [];
  for (const row of rows) {
    let top = "";
    let bottom = "";
    for (const ch of row) {
      if (ch === "e") { top += "KK"; bottom += "ww"; }
      else { top += ch + ch; bottom += ch + ch; }
    }
    out.push(top, bottom);
  }
  return out;
}

function rgb(hex) { return [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)); }

class Canvas {
  constructor(width, height, field) {
    this.width = width; this.height = height;
    this.pixels = Buffer.alloc(width * height * 4);
    const [r, g, b] = rgb(field);
    for (let i = 0; i < width * height; i += 1) this.pixels.set([r, g, b, 255], i * 4);
  }
  blit(rows, ox, oy, scale) {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const hex = PALETTE[row.charAt(x)];
        if (!hex) continue;
        const [r, g, b] = rgb(hex);
        for (let dy = 0; dy < scale; dy += 1) for (let dx = 0; dx < scale; dx += 1) {
          const px = ox + x * scale + dx, py = oy + y * scale + dy;
          if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
          this.pixels.set([r, g, b, 255], (py * this.width + px) * 4);
        }
      }
    });
  }
  fill(x0, y0, w, h, hex) {
    const [r, g, b] = rgb(hex);
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) this.pixels.set([r, g, b, 255], (y * this.width + x) * 4);
  }
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
  const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, framed, checksum]);
}
function writePng(canvas, outPath) {
  const { pixels, width, height } = canvas;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4;
  const scanlines = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  writeFileSync(outPath, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines, { level: 9 })), chunk("IEND", Buffer.alloc(0))
  ]));
}

const files = readdirSync(SPRITES).filter((name) => name.endsWith(".txt")).sort();

if (process.argv[2] === "--expand") {
  console.log(readSprite(`${process.argv[3]}.txt`).join("\n"));
  process.exit(0);
}

// Per-variant sheet: big light | big dark | 2x at 1:1 (≈64pt icon) | 1x at 1:1 (≈32pt icon), both fields.
const BIG = 8; // device px per 2x pixel
const PAD = 24;
const sheets = [];
for (const file of files) {
  const rows = readSprite(file);
  const w = rows[0].length, h = rows.length;
  const bigW = w * BIG, bigH = h * BIG;
  const smallW = w * 2 + PAD + w;
  const width = PAD + bigW + PAD + bigW + PAD + smallW + PAD;
  const height = PAD + bigH + PAD;
  const canvas = new Canvas(width, height, "#8a8a86");
  canvas.fill(PAD, PAD, bigW, bigH, FIELDS.light);
  canvas.blit(rows, PAD, PAD, BIG);
  canvas.fill(PAD * 2 + bigW, PAD, bigW, bigH, FIELDS.dark);
  canvas.blit(rows, PAD * 2 + bigW, PAD, BIG);
  const sx = PAD * 3 + bigW * 2;
  const half = Math.floor((bigH - PAD) / 2);
  canvas.fill(sx, PAD, smallW, half, FIELDS.light);
  canvas.blit(rows, sx + 8, PAD + 8, 1);
  canvas.fill(sx, PAD + half + PAD, smallW, half, FIELDS.dark);
  canvas.blit(rows, sx + 8, PAD + half + PAD + 8, 1);
  // 1x rendition: every other cell of the 2x grid.
  const onex = rows.filter((_, y) => y % 2 === 0).map((row) => row.split("").filter((_, x) => x % 2 === 0).join(""));
  canvas.blit(onex, sx + 8 + w + PAD, PAD + 8, 1);
  canvas.blit(onex, sx + 8 + w + PAD, PAD + half + PAD + 8, 1);
  const stem = file.replace(/\.txt$/, "");
  writePng(canvas, path.join(HERE, `${stem}.png`));
  sheets.push({ stem, canvas });
  console.log(`${stem}: ${w / 2} x ${h / 2} logical`);
}

// Contact sheet: every variant stacked, big light render only.
const totalH = sheets.reduce((sum, { canvas }) => sum + canvas.height, 0);
const totalW = Math.max(...sheets.map(({ canvas }) => canvas.width));
const sheet = new Canvas(totalW, totalH, "#8a8a86");
let y = 0;
for (const { canvas } of sheets) {
  for (let row = 0; row < canvas.height; row += 1) {
    canvas.pixels.copy(sheet.pixels, ((y + row) * totalW) * 4, row * canvas.width * 4, (row + 1) * canvas.width * 4);
  }
  y += canvas.height;
}
writePng(sheet, path.join(HERE, "sheet.png"));
