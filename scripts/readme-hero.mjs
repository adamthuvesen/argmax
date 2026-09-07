#!/usr/bin/env node
// Compose the README hero: two Argmax window captures on a desktop backdrop.
//
// Usage:
//   node scripts/readme-hero.mjs --main <png> --side <png> [--out assets/screenshots/hero.png]
//        [--scale 2]
//
// The inputs are renderer captures made with `scripts/ui-screenshot.mjs
// --scale 2` (their CSS size is pixel size / --scale). This script draws the
// macOS window chrome the overlay title bar leaves to the OS — traffic lights,
// rounded corners, shadow — and a warm gradient backdrop, then renders the page
// through ui-screenshot.mjs at the same scale.
//
// Recipe for fresh captures (docs/verification.md, rung 3): boot a scratch
// instance on a plain-path sample repo, run a few `bridge.mjs chat --worktree`
// sessions, then point ui-screenshot.mjs at `?remote#token=…` with an --eval
// that clicks a sidebar row (and a changed file for the review pane).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Where each window sits, in CSS pixels. The canvas grows with the main
// capture so its margins stay the same at any window size; the PNG is the
// canvas × --scale. The side window is drawn at half its capture size so it
// reads as a second, smaller window.
const MAIN = { left: 64, top: 128, right: 256, bottom: 64 };
const SIDE = { right: 40, top: 44, scale: 0.5 };

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { main: null, side: null, out: "assets/screenshots/hero.png", scale: 2 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--main") options.main = argv[++i];
    else if (arg === "--side") options.side = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--scale") options.scale = Number(argv[++i]);
    else fail(`unknown argument: ${arg}`);
  }
  if (!options.main || !options.side) fail("--main and --side are required");
  if (!Number.isFinite(options.scale) || options.scale <= 0) fail("--scale must be a positive number");
  return options;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file) {
  const header = readFileSync(file).subarray(0, 24);
  if (header.toString("latin1", 1, 4) !== "PNG") fail(`${file} is not a PNG`);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function windowMarkup({ src, left, top, width, height, name }) {
  return `
    <div class="window ${name}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px">
      <img src="${src}" width="${width}" height="${height}" alt="">
      <div class="lights"><i class="close"></i><i class="min"></i><i class="zoom"></i></div>
    </div>`;
}

const options = parseArgs(process.argv.slice(2));
const main = path.resolve(options.main);
const side = path.resolve(options.side);
const mainSize = pngSize(main);
const sideSize = pngSize(side);
const mainCss = { width: mainSize.width / options.scale, height: mainSize.height / options.scale };
const sideCss = {
  width: (sideSize.width / options.scale) * SIDE.scale,
  height: (sideSize.height / options.scale) * SIDE.scale
};
const CANVAS = {
  width: MAIN.left + mainCss.width + MAIN.right,
  height: MAIN.top + mainCss.height + MAIN.bottom
};

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${CANVAS.width}px; height: ${CANVAS.height}px; overflow: hidden; }
  body {
    position: relative;
    background:
      radial-gradient(90% 55% at 18% 108%, rgba(201, 151, 118, 0.85) 0%, rgba(201, 151, 118, 0) 100%),
      radial-gradient(70% 45% at 78% 104%, rgba(226, 190, 160, 0.9) 0%, rgba(226, 190, 160, 0) 100%),
      radial-gradient(120% 60% at 50% 62%, rgba(236, 210, 190, 0.75) 0%, rgba(236, 210, 190, 0) 100%),
      linear-gradient(180deg, #b0bfce 0%, #c5ccd6 20%, #dad3cf 38%, #ead0b9 56%, #e4c0a4 76%, #d8ac8f 100%);
  }
  .dune { position: absolute; left: 0; width: 100%; pointer-events: none; filter: blur(9px); }
  .window {
    position: absolute;
    border-radius: 12px;
    overflow: hidden;
    background: #fff;
    box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.22),
      0 30px 70px rgba(40, 24, 12, 0.32),
      0 8px 20px rgba(40, 24, 12, 0.18);
  }
  .window img { display: block; }
  .window.side { box-shadow:
      0 0 0 0.5px rgba(0, 0, 0, 0.22),
      0 22px 50px rgba(40, 24, 12, 0.3),
      0 6px 14px rgba(40, 24, 12, 0.16); }
  /* Traffic lights: 12px buttons, 8px apart, centred on y = trafficLightPosition.y. */
  .lights { position: absolute; left: 20px; top: 18px; display: flex; gap: 8px; }
  .lights i { width: 12px; height: 12px; border-radius: 50%; box-sizing: border-box; border: 0.5px solid rgba(0, 0, 0, 0.18); }
  .lights .close { background: #ff5f57; }
  .lights .min { background: #febc2e; }
  .lights .zoom { background: #28c840; }
  .window.side .lights { transform: scale(${SIDE.scale}); transform-origin: 0 0; left: ${20 * SIDE.scale}px; top: ${18 * SIDE.scale}px; }
</style>
<body>
  <svg class="dune" style="bottom:-40px;height:52%" viewBox="0 0 1440 468" preserveAspectRatio="none" aria-hidden="true">
    <path d="M-40 250 C 240 150, 520 330, 820 230 S 1260 90, 1480 170 L 1480 500 L -40 500 Z" fill="rgba(212, 166, 132, 0.5)"/>
    <path d="M-40 340 C 300 250, 580 420, 900 330 S 1320 220, 1480 290 L 1480 500 L -40 500 Z" fill="rgba(196, 144, 110, 0.45)"/>
    <path d="M-40 430 C 400 370, 800 470, 1480 400 L 1480 500 L -40 500 Z" fill="rgba(176, 122, 90, 0.3)"/>
  </svg>
  ${windowMarkup({ src: pathToFileURL(main).href, left: MAIN.left, top: MAIN.top, width: mainCss.width, height: mainCss.height, name: "main" })}
  ${windowMarkup({
    src: pathToFileURL(side).href,
    left: CANVAS.width - SIDE.right - sideCss.width,
    top: SIDE.top,
    width: sideCss.width,
    height: sideCss.height,
    name: "side"
  })}
</body>`;

const workDir = mkdtempSync(path.join(tmpdir(), "argmax-hero-"));
const page = path.join(workDir, "hero.html");
writeFileSync(page, html);
const result = spawnSync(
  process.execPath,
  [
    path.join(repoRoot, "scripts", "ui-screenshot.mjs"),
    "--url",
    pathToFileURL(page).href,
    "--width",
    String(CANVAS.width),
    "--height",
    String(CANVAS.height),
    "--scale",
    String(options.scale),
    "--settle",
    "600",
    "--out",
    path.resolve(options.out)
  ],
  { cwd: repoRoot, stdio: "inherit" }
);
rmSync(workDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
