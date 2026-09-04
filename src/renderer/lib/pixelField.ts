// Shared primitives for the accent-tinted pixel fields (the new-session
// composer backdrop and the effort slider). Kept engine-agnostic and cheap: no
// allocation in the hot path, colors resolved live from CSS tokens so every
// field tracks the user's theme and accent.

export type Rgb = { r: number; g: number; b: number };

function parseRgb(value: string): Rgb {
  const match = value.match(/(\d+(?:\.\d+)?)/g);
  if (!match || match.length < 3) return { r: 90, g: 143, b: 114 };
  return { r: Number(match[0]), g: Number(match[1]), b: Number(match[2]) };
}

// Read a CSS custom property as a concrete rgb triple. A throwaway probe with
// `color: var(--x)` resolves the whole var() chain the same way in every engine
// — more reliable than getPropertyValue, which can hand back the raw `var(...)`.
export function readColorToken(varName: string, host: HTMLElement): Rgb {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${varName})`;
  host.appendChild(probe);
  const rgb = parseRgb(getComputedStyle(probe).color);
  probe.remove();
  return rgb;
}

// Relative luminance, 0..1. Every field weighs its accent against the surface
// it sits on, because the same alpha lands very differently on ink and paper.
export function luminance({ r, g, b }: Rgb): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

// Stable per-cell hash → 0..1. Used both for mosaic jitter and as the lattice
// for the value noise below. Cheap, no allocation.
export function hash(c: number, r: number): number {
  const n = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Smooth value noise on an integer lattice. Sampling its x-coordinate against
// time makes the whole field translate horizontally — a current of pixels
// flowing left→right rather than 2D blobs drifting in place.
export function vnoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

// The mosaic's grain, shared so the two fields read as one material rather than
// two lookalikes that drift apart. CELL is the pitch; cells are drawn CELL-1
// wide, so the missing pixel is the lattice gap that makes this read as pixels
// and not as texture.
export const CELL = 5; // logical px per pixel-cell
export const FLOOR = 0.22; // minimum fraction of intensity every cell gets (keeps it dense)
export const INTENSITY_CAP = 0.85; // hard alpha ceiling
export const CREST_MIX = 0.62; // weight above which a cell leans toward accent-deep

const FX = 0.34; // horizontal feature frequency (smaller = more individual pixels)
const FY = 0.85; // vertical feature frequency
const CONTRAST = 1.7; // stretch about the midpoint, so bright flecks pop out of the stream

// Weight (0..1) of the cell at grid position (col, row) for a field scrolled by
// `scroll` phase units. Two octaves of horizontally-scrolling value noise — the
// finer one scrolls a touch faster — so the field reads as a current of small
// pixels streaming left→right rather than blobs drifting in place.
export function mosaicWeight(col: number, row: number, scroll: number): number {
  const sx = col * FX - scroll;
  const sy = row * FY;
  const w = 0.55 * vnoise(sx, sy) + 0.45 * vnoise(sx * 2.6 - scroll * 0.9, sy * 1.8 + 11.3);
  const stretched = (w - 0.5) * CONTRAST + 0.5;
  if (stretched < 0) return 0;
  if (stretched > 1) return 1;
  return stretched;
}

// Per-cell brightness jitter, so neighbouring cells of equal weight still differ.
export function mosaicJitter(col: number, row: number): number {
  return 0.8 + 0.2 * hash(col * 0.7, row * 0.7);
}

// Blend accent → accent-deep by cell weight: the brightest cells sit deepest,
// which is what gives the flat mosaic depth.
export function mosaicColor(weight: number, accent: Rgb, crest: Rgb): Rgb {
  const mix = weight > CREST_MIX ? (weight - CREST_MIX) / (1 - CREST_MIX) : 0;
  return {
    r: Math.round(accent.r + (crest.r - accent.r) * mix),
    g: Math.round(accent.g + (crest.g - accent.g) * mix),
    b: Math.round(accent.b + (crest.b - accent.b) * mix)
  };
}
