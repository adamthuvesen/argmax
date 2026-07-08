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
export function readAccent(varName: string, host: HTMLElement): Rgb {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${varName})`;
  host.appendChild(probe);
  const rgb = parseRgb(getComputedStyle(probe).color);
  probe.remove();
  return rgb;
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
