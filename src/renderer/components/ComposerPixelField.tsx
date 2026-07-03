import { useEffect, useRef, type JSX } from "react";

// The argmax field. Typing the first character of a new-session prompt ignites
// the flat composer panel into a dense stream of accent-tinted pixels. It blooms
// bold for a moment, then eases down to a quiet backdrop so the text you're
// composing dominates — flowing left→right the whole time, fading out when the
// prompt is cleared or submitted. The bloom re-fires whenever you start from an
// empty prompt. The stream is decoupled from individual keystrokes; text only
// decides whether the field is lit.
//
// Rendered on a single <canvas> behind the transparent textarea. The rAF loop
// only runs while the field is lit (and the tab is visible); it eases itself
// out and stops when the prompt empties, so an idle launcher costs nothing.
// Colors are read live from the --accent / --accent-deep tokens, so the field
// tracks the user's theme and accent without any per-theme code.

const CELL = 6; // logical px per pixel-cell
const PEAK_STRENGTH = 0.72; // cell alpha at the ignition bloom
const SETTLED_STRENGTH = 0.15; // faint ambient once the field has receded behind text (keeps text legible)
const BLOOM_EASE = 0.035; // per-frame decay of the bloom → settled (~1s)
const FLOOR = 0.32; // minimum fraction of strength every cell gets (keeps it dense, not white)
const SPEED = 0.021; // how fast the current scrolls left→right
const FX = 0.28; // horizontal feature frequency (smaller features = more individual pixels)
const FY = 0.78; // vertical feature frequency (features slightly wider than tall → streaks)
const INTEN_CAP = 0.8; // hard alpha ceiling
const OPACITY_EASE = 0.06; // per-frame approach toward target opacity

type Rgb = { r: number; g: number; b: number };

function parseRgb(value: string): Rgb {
  const match = value.match(/(\d+(?:\.\d+)?)/g);
  if (!match || match.length < 3) return { r: 90, g: 143, b: 114 };
  return { r: Number(match[0]), g: Number(match[1]), b: Number(match[2]) };
}

// Read a CSS custom property as a concrete rgb triple. A throwaway probe with
// `color: var(--x)` resolves the whole var() chain the same way in every engine
// — more reliable than getPropertyValue, which can hand back the raw `var(...)`.
function readAccent(varName: string, host: HTMLElement): Rgb {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${varName})`;
  host.appendChild(probe);
  const rgb = parseRgb(getComputedStyle(probe).color);
  probe.remove();
  return rgb;
}

// Stable per-cell hash → 0..1. Used both for the mosaic jitter and as the
// lattice for the value noise below. Cheap, no allocation.
function hash(c: number, r: number): number {
  const n = Math.sin(c * 127.1 + r * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Smooth value noise on an integer lattice. Sampling its x-coordinate against
// time makes the whole field translate horizontally — a current of pixels
// flowing left→right rather than 2D blobs drifting in place.
function vnoise(x: number, y: number): number {
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

export function ComposerPixelField({ text }: { text: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef(text.trim().length > 0);
  // Imperative "state changed" hook the text effect calls to wake the loop (or
  // repaint the static field) without re-running the setup effect below.
  const kickRef = useRef<(() => void) | null>(null);

  // Text drives one thing only: whether the field is lit. The first non-empty
  // character ignites it; emptying the prompt (or a submit that clears it) puts
  // it out. Everything else — the flow — is self-driven.
  useEffect(() => {
    activeRef.current = text.trim().length > 0;
    kickRef.current?.();
  }, [text]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let accent = readAccent("--accent", host);
    let crest = readAccent("--accent-deep", host);
    let width = 0;
    let height = 0;
    let opacity = 0;
    let bloom = 0; // 1 at ignition, decays toward 0 (settled)
    let wasActive = false;
    let raf = 0;
    let running = false;

    const resize = (): void => {
      width = host.clientWidth;
      height = host.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // Draw one frame at time `now` with global field opacity `op` and per-cell
    // peak alpha `strength` (higher during the bloom, lower once settled). The
    // geometry is shared by the animated loop and the reduced-motion static paint.
    const draw = (now: number, op: number, strength: number): void => {
      ctx.clearRect(0, 0, width, height);
      if (op <= 0.004) return;
      const cols = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL);
      const scroll = now * SPEED; // the whole noise field slides left→right

      for (let r = 0; r < rows; r += 1) {
        const sy = r * FY;
        for (let c = 0; c < cols; c += 1) {
          const sx = c * FX - scroll; // sampling x scrolls with time → features move right
          // Two octaves of horizontally-scrolling noise (the finer one scrolls a
          // touch faster) → a fast current of small pixels. Contrast-stretched so
          // bright flecks pop out of the stream; floored so it stays dense.
          let w = 0.55 * vnoise(sx, sy) + 0.45 * vnoise(sx * 2.6 - scroll * 0.9, sy * 1.8 + 11.3);
          w = (w - 0.5) * 1.7 + 0.5;
          if (w < 0) w = 0;
          else if (w > 1) w = 1;
          const jitter = 0.8 + 0.2 * hash(c * 0.7, r * 0.7);
          let intensity = strength * (FLOOR + (1 - FLOOR) * w) * jitter;
          if (intensity > INTEN_CAP) intensity = INTEN_CAP;
          if (intensity < 0.02) continue;

          // Brighter cells lean toward accent-deep for depth.
          const mix = w > 0.62 ? (w - 0.62) / 0.38 : 0;
          const cr = Math.round(accent.r + (crest.r - accent.r) * mix);
          const cg = Math.round(accent.g + (crest.g - accent.g) * mix);
          const cb = Math.round(accent.b + (crest.b - accent.b) * mix);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${(intensity * op).toFixed(3)})`;
          ctx.fillRect(c * CELL, r * CELL, CELL - 1, CELL - 1);
        }
      }
    };

    const tick = (): void => {
      const now = performance.now();
      const active = activeRef.current;
      if (active && !wasActive) bloom = 1; // ignition → bloom bold, then recede
      wasActive = active;
      const target = active ? 1 : 0;
      opacity += (target - opacity) * OPACITY_EASE;
      bloom += (0 - bloom) * BLOOM_EASE;
      const strength = SETTLED_STRENGTH + (PEAK_STRENGTH - SETTLED_STRENGTH) * bloom;
      draw(now, opacity, strength);
      if (target === 0 && opacity < 0.01) {
        opacity = 0;
        bloom = 0;
        ctx.clearRect(0, 0, width, height);
        running = false;
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    const start = (): void => {
      if (running || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    // Reduced motion: no loop, no bloom. Snap to the settled field when there's
    // text, clear it when there isn't.
    const paintStatic = (): void => {
      opacity = activeRef.current ? 1 : 0;
      draw(0, opacity, SETTLED_STRENGTH);
    };

    kickRef.current = reduceMotion ? paintStatic : start;
    if (reduceMotion) paintStatic();
    else if (activeRef.current) start();

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reduceMotion) paintStatic();
      else start();
    });
    resizeObserver.observe(host);

    // Refresh colors when the theme or accent attribute flips on <html>.
    const themeObserver = new MutationObserver(() => {
      accent = readAccent("--accent", host);
      crest = readAccent("--accent-deep", host);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent"]
    });

    const onVisibility = (): void => {
      if (!reduceMotion && !document.hidden && activeRef.current) start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      kickRef.current = null;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="composer-pixel-field" aria-hidden="true" />;
}
