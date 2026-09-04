import { useEffect, useRef, type JSX } from "react";
import {
  CELL,
  FLOOR,
  INTENSITY_CAP,
  luminance,
  mosaicColor,
  mosaicJitter,
  mosaicWeight,
  readColorToken,
  type Rgb
} from "../lib/pixelField.js";

// The argmax field. Typing the first character of a new-session prompt sinks the
// composer panel and ignites it into a dense stream of accent-tinted pixels. It
// blooms bold for a moment, then eases down to a quiet backdrop so the text
// you're composing dominates — flowing left→right the whole time, fading out
// when the prompt is cleared or submitted. The bloom re-fires whenever you start
// from an empty prompt. The stream is decoupled from individual keystrokes; text
// only decides whether the field is lit.
//
// Same mosaic as the effort rail, from the same module: same cell pitch, same
// noise, same accent→accent-deep crest, and the same sunken ground under it,
// because the rail is where that material was tuned and two hand-tuned copies
// would drift. What differs is scale — this one is the size of a panel and has
// UI on top of it, so it ramps from quiet at the caret to full at the right edge
// and scales itself against the accent and theme it's drawn on.
//
// Rendered on a single <canvas> behind the transparent textarea. The rAF loop
// only runs while the field is lit (and the tab is visible); it eases itself
// out and stops when the prompt empties, so an idle launcher costs nothing.
// Colors are read live from CSS tokens, so the field tracks the user's theme and
// accent without any per-theme code.

const PEAK_STRENGTH = 0.85; // cell alpha at the ignition bloom
const SETTLED_STRENGTH = 0.5; // ambient once the field has receded behind text
const SPEED = 0.021; // how fast the current scrolls left→right
// Like the effort rail, this paints at ~30 fps: decorative flow is
// indistinguishable from 60 fps and the per-cell noise is the whole cost. The
// eases below are per *painted* frame, so they are twice the rate a 60 fps loop
// would use and land on the same wall-clock timings.
const PAINT_INTERVAL = 33; // ms between paints
const BLOOM_EASE = 0.07; // decay of the bloom → settled (~1s)
const OPACITY_EASE = 0.12; // approach toward target opacity (~0.8s)
// The effort rail ramps brightest at its leading edge; the composer has no fill
// edge, so it ramps across the whole panel: quiet under the caret, gathering
// toward the empty right side. Without it the mosaic is a uniform wall of cells
// with no dark gaps — texture, not pixels.
const RAMP_HEAD = 0.18; // intensity multiplier at the left edge
const RAMP_TAIL = 1; // …and at the right edge
// Two corrections keep the field's weight even across themes and accents. A
// dark tint on a light ground reads heavier than a glow on a dark one, and this
// field is two orders of magnitude larger than the effort rail, so light themes
// take the whole thing down. And an accent further from the ground than the
// sage default (dark neutral is nearly white) is scaled back to sage's distance,
// or its mosaic swallows the chips sitting on top of it.
const LIGHT_GROUND_SCALE = 0.68;
const REFERENCE_CONTRAST = 0.55; // luminance distance of the default accent from its ground

function groundScaleFor(accent: Rgb, ground: Rgb): number {
  const contrast = Math.abs(luminance(accent) - luminance(ground));
  const light = luminance(ground) > 0.5 ? LIGHT_GROUND_SCALE : 1;
  return light * Math.min(1, REFERENCE_CONTRAST / Math.max(contrast, 0.01));
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

    let accent = readColorToken("--accent", host);
    let crest = readColorToken("--accent-deep", host);
    let sunken = readColorToken("--panel-sunken", host);
    let groundScale = groundScaleFor(accent, sunken);
    let width = 0;
    let height = 0;
    let opacity = 0;
    let bloom = 0; // 1 at ignition, decays toward 0 (settled)
    let wasActive = false;
    let raf = 0;
    let running = false;
    let lastPaint = 0;

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

      // Sink the panel under the mosaic, the way the effort rail sits on
      // --panel-sunken. A mosaic only reads as pixels when its gaps are darker
      // than its cells; on the composer's own panel colour the gaps are lighter
      // than half the cells and the whole thing collapses into grain.
      ctx.fillStyle = `rgba(${sunken.r},${sunken.g},${sunken.b},${op.toFixed(3)})`;
      ctx.fillRect(0, 0, width, height);

      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const x = c * CELL;
          const w = mosaicWeight(c, r, scroll);
          const ramp = RAMP_HEAD + (RAMP_TAIL - RAMP_HEAD) * (x / width);
          let intensity = strength * groundScale * ramp * (FLOOR + (1 - FLOOR) * w) * mosaicJitter(c, r);
          if (intensity > INTENSITY_CAP) intensity = INTENSITY_CAP;
          if (intensity < 0.02) continue;
          const { r: cr, g: cg, b: cb } = mosaicColor(w, accent, crest);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${(intensity * op).toFixed(3)})`;
          ctx.fillRect(x, r * CELL, CELL - 1, CELL - 1);
        }
      }
    };

    const tick = (): void => {
      // A backgrounded window gains nothing from new frames — park the loop and
      // let `visibilitychange` restart it.
      if (document.hidden) {
        running = false;
        raf = 0;
        return;
      }
      const now = performance.now();
      if (now - lastPaint < PAINT_INTERVAL) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastPaint = now;
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
      accent = readColorToken("--accent", host);
      crest = readColorToken("--accent-deep", host);
      sunken = readColorToken("--panel-sunken", host);
      groundScale = groundScaleFor(accent, sunken);
      if (reduceMotion) paintStatic();
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
