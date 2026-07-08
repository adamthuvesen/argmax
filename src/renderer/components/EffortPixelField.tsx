import { useEffect, useRef, type JSX } from "react";
import { hash, readAccent, vnoise, type Rgb } from "../lib/pixelField.js";

// Accent pixel mosaic for the effort slider. It fills the track from the left up
// to `level` (0..1) and streams left→right; `speed` (0..1) sets the current's
// rate, so a higher effort visibly flows faster. Brighter toward the fill edge
// so the mosaic reads as intensity. At the highest efforts the leading edge
// throws off sparks — pixels that fan out past the rail as if it's overheating.
// Purely decorative — the slider on top owns interaction.

const CELL = 5; // logical px per pixel-cell
// Scroll rate (phase units per ms) = BASE + RANGE * speed^CURVE. `speed` is the
// continuous thumb position, so during a drag the rate rises smoothly the whole
// way from one stop to the next. The mild curve keeps the four stops clearly
// separated (medium well below high, high below xhigh) without flattening the
// mid-range into a dead zone — so the acceleration is visible as you move.
const BASE_SPEED = 0.0026; // barely-crawling drift at the lowest effort
const SPEED_RANGE = 0.036; // extra rate at the highest effort
const SPEED_CURVE = 1.6; // >1 keeps the slow end slower; gentle enough to ramp smoothly
const FX = 0.34; // horizontal feature frequency (smaller = more individual pixels)
const FY = 0.85; // vertical feature frequency
const FLOOR = 0.22; // minimum fraction of intensity every cell gets (keeps it dense)
const INTEN_CAP = 0.85; // hard alpha ceiling
// Overall accent brightness scales with effort: dimmer at low, vivid toward
// xhigh. BRIGHT_FLOOR is the alpha multiplier at the slowest speed.
const BRIGHT_FLOOR = 0.5;

// The canvas overscans the rail so sparks thrown off the beam aren't clipped;
// the fill is still drawn only inside the rail band (offset by OVERSCAN_TOP).
const OVERSCAN_TOP = 15; // px above the rail
const OVERSCAN_BOTTOM = 15; // px below the rail
const OVERSCAN_RIGHT = 14; // px past the rail's right edge (ahead of the beam)

// Sparks kick in only near the top of the range and ramp hard toward xhigh.
const SPARK_ON = 0.62; // speed below this → no sparks (≈ just under High)
const SPARK_RATE = 3.4; // max sparks spawned per ~16ms frame at full effort
const SPARK_SPEED = 0.055; // base ejection velocity (px/ms)
const SPARK_LIFE = 620; // ms before a spark fully fades
const SPARK_GRAVITY = 0.00016; // px/ms² downward pull, so arcs curve back down
const SPARK_MAX = 180; // hard cap on live sparks
const SPARK_SPREAD = Math.PI * 0.82; // half-fan (±) around the +x axis: right, up, down, diagonals

type Spark = { x: number; y: number; vx: number; vy: number; life: number };

export function EffortPixelField({ level, speed }: { level: number; speed: number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  const speedRef = useRef(speed);

  // Live values the rAF loop reads without re-running its setup effect.
  useEffect(() => {
    levelRef.current = level;
    speedRef.current = speed;
  }, [level, speed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let accent: Rgb = readAccent("--accent", host);
    let crest: Rgb = readAccent("--accent-deep", host);
    let railW = 0; // the rail's own width/height (the track element)
    let railH = 0;
    let width = 0; // the canvas' overscanned size
    let height = 0;
    let raf = 0;
    let shownLevel = levelRef.current; // eased fill, so snaps glide instead of jumping
    let shownSpeed = speedRef.current; // eased rate, so a step change ramps up/down
    let scroll = 0; // accumulated flow phase (advanced by dt*rate, never now*rate)
    let last = 0;
    const sparks: Spark[] = [];

    const resize = (): void => {
      railW = host.clientWidth;
      railH = host.clientHeight;
      width = railW + OVERSCAN_RIGHT;
      height = railH + OVERSCAN_TOP + OVERSCAN_BOTTOM;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    // The rail sits inside the overscanned canvas, pushed down by OVERSCAN_TOP.
    const drawFill = (): void => {
      const fillWidth = railW * shownLevel;
      if (fillWidth <= 0.5) return;
      const cols = Math.ceil(railW / CELL);
      const rows = Math.ceil(railH / CELL);
      // Brightness climbs with effort, so the accent starts muted and grows vivid.
      const bright = BRIGHT_FLOOR + (1 - BRIGHT_FLOOR) * shownSpeed;

      for (let r = 0; r < rows; r += 1) {
        const sy = r * FY;
        for (let c = 0; c < cols; c += 1) {
          const x = c * CELL;
          if (x >= fillWidth) break; // only the filled portion is pixelated
          const sx = c * FX - scroll; // sampling x scrolls with time → features move right
          let w = 0.55 * vnoise(sx, sy) + 0.45 * vnoise(sx * 2.6 - scroll * 0.9, sy * 1.8 + 11.3);
          w = (w - 0.5) * 1.7 + 0.5;
          if (w < 0) w = 0;
          else if (w > 1) w = 1;
          // Ramp brighter toward the fill edge (right), fainter at the start.
          const ramp = 0.2 + 0.8 * (x / fillWidth);
          const jitter = 0.8 + 0.2 * hash(c * 0.7, r * 0.7);
          let intensity = ramp * (FLOOR + (1 - FLOOR) * w) * jitter * bright;
          if (intensity > INTEN_CAP) intensity = INTEN_CAP;
          if (intensity < 0.02) continue;
          // Brighter cells lean toward accent-deep for depth.
          const mix = w > 0.62 ? (w - 0.62) / 0.38 : 0;
          const cr = Math.round(accent.r + (crest.r - accent.r) * mix);
          const cg = Math.round(accent.g + (crest.g - accent.g) * mix);
          const cb = Math.round(accent.b + (crest.b - accent.b) * mix);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${intensity.toFixed(3)})`;
          ctx.fillRect(x, OVERSCAN_TOP + r * CELL, CELL - 1, CELL - 1);
        }
      }
    };

    const spawnSpark = (): void => {
      const edgeX = railW * shownLevel;
      // Fan centered on +x (rightward, ahead of the beam), reaching up and down.
      const angle = (Math.random() * 2 - 1) * SPARK_SPREAD;
      const vel = SPARK_SPEED * (0.5 + Math.random());
      sparks.push({
        x: edgeX + (Math.random() * 2 - 1) * 2,
        y: OVERSCAN_TOP + Math.random() * railH,
        vx: Math.cos(angle) * vel,
        vy: Math.sin(angle) * vel,
        life: SPARK_LIFE * (0.6 + 0.5 * Math.random())
      });
    };

    const updateSparks = (dt: number): void => {
      const heat = Math.max(0, (shownSpeed - SPARK_ON) / (1 - SPARK_ON));
      let load = heat * heat * SPARK_RATE * (dt / 16); // hard ramp toward xhigh
      while (load > 0 && sparks.length < SPARK_MAX) {
        if (load >= 1 || Math.random() < load) spawnSpark();
        load -= 1;
      }
      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const s = sparks[i];
        if (!s) continue;
        s.life -= dt;
        if (s.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        s.vy += SPARK_GRAVITY * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        const alpha = Math.min(0.9, (s.life / SPARK_LIFE) * 0.95);
        ctx.fillStyle = `rgba(${crest.r},${crest.g},${crest.b},${alpha.toFixed(3)})`;
        ctx.fillRect(Math.round(s.x), Math.round(s.y), CELL - 1, CELL - 1);
      }
    };

    const paint = (): void => {
      ctx.clearRect(0, 0, width, height);
      drawFill();
    };

    // Static paint for reduced motion: settle to the target level, no flow, no
    // sparks (they read as motion).
    const paintStatic = (): void => {
      shownLevel = levelRef.current;
      sparks.length = 0;
      paint();
    };

    const tick = (): void => {
      const now = performance.now();
      const dt = last === 0 ? 16 : Math.min(64, now - last);
      last = now;
      shownLevel += (levelRef.current - shownLevel) * 0.2;
      shownSpeed += (speedRef.current - shownSpeed) * 0.2;
      const rate = BASE_SPEED + SPEED_RANGE * Math.pow(shownSpeed, SPEED_CURVE);
      scroll += dt * rate;
      paint();
      updateSparks(dt);
      raf = requestAnimationFrame(tick);
    };

    if (reduceMotion) paintStatic();
    else raf = requestAnimationFrame(tick);

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reduceMotion) paintStatic();
    });
    resizeObserver.observe(host);

    // Refresh colors when the theme or accent attribute flips on <html>.
    const themeObserver = new MutationObserver(() => {
      accent = readAccent("--accent", host);
      crest = readAccent("--accent-deep", host);
      if (reduceMotion) paintStatic();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent"]
    });

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="effort-pixel-field" aria-hidden="true" />;
}
