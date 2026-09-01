#!/usr/bin/env node
// Builds every app-icon artifact from one pixel grid and one palette.
//
// The mark is the pixel fox the in-app mascot draws
// (src/renderer/components/Mascot.tsx); both read assets/fox-mascot.txt, so an
// edit to the sprite moves the icon and the mascot together. The fox keeps one
// palette across both appearances — it reads as a fox because cream separates
// from orange, and only the field changes:
//
//   light: near-white field
//   dark:  warm charcoal field (the shade the dark theme uses for --bg, so the
//          icon and the app agree)
//
// Outputs:
//   assets/icon.svg, assets/icon-dark.svg     browsable squircle artwork
//   assets/icon.png, assets/icon-dark.png     1024px renders (README, docs)
//   assets/Argmax.icon/                       Icon Composer source package
//   public/argmax-icon.png                    PWA manifest icon (unhashed)
//   src-tauri/icons/icon.icns                 legacy icon, macOS < 26
//   src-tauri/icons/Assets.car                appearance-aware icon, macOS 26+
//
// The PNGs are drawn here rather than rasterised from the SVGs: the artwork is
// axis-aligned rectangles plus one rounded rect, so exact coverage is a few
// lines of maths, and macOS's only bundled rasteriser (qlmanage) flattens SVG
// transparency to white. That is what left the icon with a white border in
// c50356e.
//
// macOS only: the .icns needs sips and Assets.car needs Xcode 26's
// actool. Both artifacts are committed so an ordinary `tauri build` never has
// to run this.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = path.join(ROOT, "assets");
const TAURI_ICONS = path.join(ROOT, "src-tauri", "icons");
const PUBLIC = path.join(ROOT, "public");
const ICON_PACKAGE = path.join(ASSETS, "Argmax.icon");

const APPEARANCES = {
  light: { field: "#fefefe" },
  dark: { field: "#1b1b18" }
};

// One entry per sprite character. Painted in this order so the eye highlights
// land over the outline blocks that hold them.
const PALETTE = [
  ["K", "#592718"],
  ["o", "#c6663a"],
  ["d", "#99442d"],
  ["c", "#ebe1cf"],
  ["t", "#bca595"],
  ["x", "#110b0f"],
  ["w", "#ffffff"]
];

const GRID = readFileSync(path.join(ASSETS, "fox-mascot.txt"), "utf8")
  .split("\n")
  .filter((row) => row !== "" && !row.startsWith("#"));
const INK = new Map(PALETTE);
const GRID_W = GRID[0].length;
const GRID_H = GRID.length;

const CANVAS = 1024;
// 56 × 16 wide, 40 × 16 tall: the sprite is wide and short, so the cell is
// picked off the width and the fox sits band-centred on the square.
const CELL = 16;
const MARK_X = (CANVAS - GRID_W * CELL) / 2;
const MARK_Y = (CANVAS - GRID_H * CELL) / 2;
// macOS reserves the outer ~10% of a legacy icon as breathing room, so the
// squircle sits at 80% of the canvas. Icon Composer draws the icon shape
// itself, which is why the .icon layer uses the same mark on the full canvas.
const SQUIRCLE_INSET = 102;
const SQUIRCLE_SIZE = 820;
const SQUIRCLE_RADIUS = 232;

/**
 * Greedy maximal-rectangle cover of every cell holding `cell`. The sprite is
 * drawn at 2x, so merging vertically as well as horizontally more than halves
 * the geometry: 128 rects across all seven layers instead of 316 runs.
 */
function coverCells(cell) {
  const taken = GRID.map(() => new Array(GRID_W).fill(false));
  const rects = [];

  const free = (x, y) => !taken[y][x] && GRID[y].charAt(x) === cell;
  const rowFree = (y, from, to) => {
    for (let x = from; x <= to; x += 1) {
      if (!free(x, y)) return false;
    }
    return true;
  };

  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (!free(x, y)) continue;
      let right = x;
      while (right + 1 < GRID_W && free(right + 1, y)) right += 1;
      let bottom = y;
      while (bottom + 1 < GRID_H && rowFree(bottom + 1, x, right)) bottom += 1;
      for (let row = y; row <= bottom; row += 1) {
        for (let col = x; col <= right; col += 1) taken[row][col] = true;
      }
      rects.push({ x, y, width: right - x + 1, height: bottom - y + 1 });
    }
  }
  return rects;
}

/** One <g> per palette entry, in grid coordinates; the caller scales them. */
function markGroups() {
  return PALETTE.map(([cell, hex]) => {
    const rects = coverCells(cell)
      .map(({ x, y, width, height }) => `        <rect x="${x}" y="${y}" width="${width}" height="${height}"/>`)
      .join("\n");
    return `      <g fill="${hex}">\n${rects}\n      </g>`;
  }).join("\n");
}

/** Squircle artwork: the app icon as it ships to macOS < 26 and to the README. */
function squircleSvg({ field }) {
  // The inner <svg> carries the 80% inset so the squircle rect stays at the
  // origin. qlmanage silently drops rounded rects with a non-zero x/y.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${CANVAS}" height="${CANVAS}">
  <!-- Generated by scripts/build-icons.mjs from assets/fox-mascot.txt. -->
  <svg x="${SQUIRCLE_INSET}" y="${SQUIRCLE_INSET}" width="${SQUIRCLE_SIZE}" height="${SQUIRCLE_SIZE}" viewBox="0 0 ${CANVAS} ${CANVAS}">
    <rect width="${CANVAS}" height="${CANVAS}" rx="${SQUIRCLE_RADIUS}" fill="${field}"/>
    <g transform="translate(${MARK_X} ${MARK_Y}) scale(${CELL})" shape-rendering="crispEdges">
${markGroups()}
    </g>
  </svg>
</svg>
`;
}

function srgb(hex) {
  const channels = [1, 3, 5].map((at) => (Number.parseInt(hex.slice(at, at + 2), 16) / 255).toFixed(5));
  return `srgb:${channels.join(",")},1.00000`;
}

/** Icon Composer document: one full-colour mark layer over a tinted field. */
function iconDocument() {
  return {
    "fill-specializations": [
      { value: { solid: srgb(APPEARANCES.light.field) } },
      { appearance: "dark", value: { solid: srgb(APPEARANCES.dark.field) } }
    ],
    groups: [
      {
        layers: [
          {
            // No fill-specializations: a solid tint is for monochrome marks,
            // and flattening the fox to one colour is exactly what stops it
            // reading as a fox. The layer ships its own palette instead, and
            // only the field behind it changes with the appearance.
            name: "mark",
            "image-name": "mark.png"
          }
        ],
        // No shadow, specular or translucency: Liquid Glass's default bevel
        // reads as embossing on a flat pixel mark, which fights the artwork.
        // macOS still supplies the icon shape, so the mark stays crisp.
        lighting: "individual",
        specular: false,
        shadow: { kind: "none", opacity: 0.5 },
        translucency: { enabled: false, value: 0.5 }
      }
    ],
    "supported-platforms": { squares: "shared" }
  };
}

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function rgb(hex) {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * Coverage of the rounded rect over the pixel at (x, y), from its signed
 * distance. One sample per pixel is enough because the boundary is smooth.
 */
function fieldCoverage(x, y) {
  const scale = SQUIRCLE_SIZE / CANVAS;
  const half = SQUIRCLE_SIZE / 2;
  const radius = SQUIRCLE_RADIUS * scale;
  const qx = Math.abs(x + 0.5 - (SQUIRCLE_INSET + half)) - (half - radius);
  const qy = Math.abs(y + 0.5 - (SQUIRCLE_INSET + half)) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return clamp01(0.5 - (outside + Math.min(Math.max(qx, qy), 0) - radius));
}

/**
 * Exact coverage of the mark over the pixel at (x, y). The grid cells are
 * axis-aligned, so this is the overlapping area of the (at most four) cells the
 * pixel touches, accumulated as an area-weighted colour. Blending the union
 * rather than compositing per-rect alpha is what keeps seams from showing
 * between adjacent cells of different colours.
 */
function markSample(x, y, cell, originX, originY) {
  const left = (x - originX) / cell;
  const top = (y - originY) / cell;
  const right = left + 1 / cell;
  const bottom = top + 1 / cell;

  let covered = 0;
  const colour = [0, 0, 0];
  for (let row = Math.floor(top); row < Math.ceil(bottom); row += 1) {
    if (row < 0 || row >= GRID_H) continue;
    const height = Math.min(bottom, row + 1) - Math.max(top, row);
    for (let col = Math.floor(left); col < Math.ceil(right); col += 1) {
      if (col < 0 || col >= GRID_W) continue;
      const hex = INK.get(GRID[row].charAt(col));
      if (!hex) continue;
      const area = (Math.min(right, col + 1) - Math.max(left, col)) * height * cell * cell;
      covered += area;
      const [r, g, b] = rgb(hex);
      colour[0] += r * area;
      colour[1] += g * area;
      colour[2] += b * area;
    }
  }
  if (covered <= 0) return { coverage: 0, colour };
  return { coverage: clamp01(covered), colour: colour.map((channel) => channel / covered) };
}

/**
 * Draws the icon at CANVAS×CANVAS. Without a field the mark is rendered alone
 * on transparency, which is the layer the .icon package composites.
 */
function render({ field }) {
  const pixels = Buffer.alloc(CANVAS * CANVAS * 4);
  const inset = field !== undefined;
  const scale = inset ? SQUIRCLE_SIZE / CANVAS : 1;
  const cell = CELL * scale;
  const originX = inset ? SQUIRCLE_INSET + MARK_X * scale : MARK_X;
  const originY = inset ? SQUIRCLE_INSET + MARK_Y * scale : MARK_Y;
  const fieldRgb = inset ? rgb(field) : null;

  for (let y = 0; y < CANVAS; y += 1) {
    for (let x = 0; x < CANVAS; x += 1) {
      const { coverage, colour } = markSample(x, y, cell, originX, originY);
      const alpha = inset ? fieldCoverage(x, y) : coverage;
      const at = (y * CANVAS + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = fieldRgb ? fieldRgb[channel] : colour[channel];
        pixels[at + channel] = Math.round(base + (colour[channel] - base) * coverage);
      }
      pixels[at + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
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

function writePng(pixels, outPath) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(CANVAS, 0);
  header.writeUInt32BE(CANVAS, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha

  // One filter byte per scanline. The artwork is flat colour, so "none" (0)
  // compresses fine and keeps the encoder trivial.
  const stride = CANVAS * 4;
  const scanlines = Buffer.alloc(CANVAS * (stride + 1));
  for (let y = 0; y < CANVAS; y += 1) {
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

const ICNS_RENDITIONS = [
  { points: 16, scale: 1, type: "icp4" },
  { points: 16, scale: 2, type: "ic11" },
  { points: 32, scale: 1, type: "icp5" },
  { points: 32, scale: 2, type: "ic12" },
  { points: 128, scale: 1, type: "ic07" },
  { points: 128, scale: 2, type: "ic13" },
  { points: 256, scale: 1, type: "ic08" },
  { points: 256, scale: 2, type: "ic14" },
  { points: 512, scale: 1, type: "ic09" },
  { points: 512, scale: 2, type: "ic10" }
];

function icnsChunk(type, png) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32BE(png.length + header.length, 4);
  return Buffer.concat([header, png]);
}

function validateIcns(icns) {
  if (icns.subarray(0, 4).toString("ascii") !== "icns" || icns.readUInt32BE(4) !== icns.length) {
    throw new Error("Generated ICNS has an invalid container header");
  }

  const types = [];
  for (let offset = 8; offset < icns.length; ) {
    const type = icns.subarray(offset, offset + 4).toString("ascii");
    const length = icns.readUInt32BE(offset + 4);
    if (length < 16 || offset + length > icns.length) {
      throw new Error(`Generated ICNS has an invalid ${type} chunk`);
    }
    const signature = icns.subarray(offset + 8, offset + 16).toString("hex");
    if (signature !== "89504e470d0a1a0a") {
      throw new Error(`Generated ICNS ${type} chunk is not a PNG`);
    }
    types.push(type);
    offset += length;
  }

  const expected = ICNS_RENDITIONS.map(({ type }) => type);
  if (types.join(",") !== expected.join(",")) {
    throw new Error(`Generated ICNS has unexpected chunks: ${types.join(", ")}`);
  }
}

function buildIcns(sourcePng, scratch) {
  const chunks = ICNS_RENDITIONS.map(({ points, scale, type }) => {
    const target = path.join(scratch, `${type}.png`);
    const pixels = String(points * scale);
    run("sips", ["-z", pixels, pixels, sourcePng, "--out", target]);
    return icnsChunk(type, readFileSync(target));
  });
  const header = Buffer.alloc(8);
  const length = header.length + chunks.reduce((total, chunk) => total + chunk.length, 0);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(length, 4);
  const icns = Buffer.concat([header, ...chunks]);
  validateIcns(icns);
  writeFileSync(path.join(TAURI_ICONS, "icon.icns"), icns);
}

function buildAssetsCar(scratch) {
  const version = run("actool", ["--version", "--output-format=human-readable-text"]);
  const major = Number.parseInt(version.match(/short-bundle-version:\s*(\d+)/)?.[1] ?? "", 10);
  if (!(major >= 26)) {
    throw new Error(`Assets.car needs Xcode 26's actool. Found ${major || "an unreadable version"}`);
  }

  // actool names the compiled asset after the package, and Tauri reads that name
  // back out of Assets.car to set CFBundleIconName. Argmax.icon has to keep
  // the product name.
  const out = path.join(scratch, "car");
  mkdirSync(out);
  run("actool", [
    ICON_PACKAGE,
    "--compile",
    out,
    "--output-format",
    "human-readable-text",
    "--notices",
    "--warnings",
    "--app-icon",
    "Argmax",
    "--include-all-app-icons",
    "--platform",
    "macosx",
    "--minimum-deployment-target",
    "11.0",
    "--output-partial-info-plist",
    path.join(out, "partial.plist")
  ]);

  const car = path.join(TAURI_ICONS, "Assets.car");
  cpSync(path.join(out, "Assets.car"), car);

  const info = JSON.parse(run("assetutil", ["--info", car]));
  const named = info.find((entry) => entry.AssetType === "Icon Image")?.Name;
  if (named !== "Argmax") {
    throw new Error(`Assets.car has no "Argmax" Icon Image asset. Tauri would skip CFBundleIconName`);
  }
}

const scratch = mkdtempSync(path.join(tmpdir(), "argmax-icons-"));
try {
  mkdirSync(TAURI_ICONS, { recursive: true });
  mkdirSync(path.join(ICON_PACKAGE, "Assets"), { recursive: true });

  for (const [appearance, palette] of Object.entries(APPEARANCES)) {
    const stem = appearance === "light" ? "icon" : `icon-${appearance}`;
    writeFileSync(path.join(ASSETS, `${stem}.svg`), squircleSvg(palette));
    writePng(render(palette), path.join(ASSETS, `${stem}.png`));
  }

  // The .icon layer is the fox on transparency, at full colour. icon.json
  // supplies both fields, so the package carries one asset rather than one per
  // appearance.
  writePng(render({}), path.join(ICON_PACKAGE, "Assets", "mark.png"));
  writeFileSync(path.join(ICON_PACKAGE, "icon.json"), `${JSON.stringify(iconDocument(), null, 2)}\n`);

  // The PWA icon has to live in public/: Vite hashes anything referenced from
  // HTML, and manifest.webmanifest is copied verbatim, so a hashed path would
  // 404 for the installed app. Same render, unhashed name.
  mkdirSync(PUBLIC, { recursive: true });
  cpSync(path.join(ASSETS, "icon.png"), path.join(PUBLIC, "argmax-icon.png"));

  buildIcns(path.join(ASSETS, "icon.png"), scratch);
  buildAssetsCar(scratch);

  console.log(
    "icons rebuilt: assets/icon{,-dark}.{svg,png}, assets/Argmax.icon, public/argmax-icon.png, src-tauri/icons/{icon.icns,Assets.car}"
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
