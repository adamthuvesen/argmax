import { useEffect, useRef, type JSX } from "react";
import {
  CELL,
  FLOOR,
  hash,
  INTENSITY_CAP,
  luminance,
  mosaicColor,
  mosaicJitter,
  mosaicWeight,
  readColorToken,
  vnoise,
  type Rgb
} from "../lib/pixelField.js";

// Accent pixel mosaic for the effort slider. It fills the track from the left up
// to `level` (0..1) and streams left→right; `heat` (0..1, the effort on the
// canonical low→ultra scale) sets the current's rate and how far the field is
// pushed past its comfort zone. Brighter toward the fill edge so the mosaic
// reads as intensity. The upper stops escalate in tiers:
//   xhigh (0.6) — the leading edge runs white-hot and throws sparks
//   max   (0.8) — brightness surges roll through the fill, sparks fly further
//   ultra (1.0) — the field tears: rows shear, cells blow out or drop, bolts
//                 of lightning jump off the edge, sparks erupt from everywhere
// Purely decorative — the slider on top owns interaction.

// Scroll rate (phase units per ms) = BASE + RANGE * heat^CURVE. `heat` is the
// continuous thumb position, so during a drag the rate rises smoothly the whole
// way from one stop to the next. The mild curve keeps the stops clearly
// separated (medium well below high, high below xhigh) without flattening the
// mid-range into a dead zone — so the acceleration is visible as you move.
const BASE_SPEED = 0.0026; // barely-crawling drift at the lowest effort
const SPEED_RANGE = 0.036; // extra rate at the highest effort
const SPEED_CURVE = 1.6; // >1 keeps the slow end slower; gentle enough to ramp smoothly
// Overall accent brightness scales with effort: dimmer at low, vivid toward
// xhigh. BRIGHT_FLOOR is the alpha multiplier at the slowest speed.
const BRIGHT_FLOOR = 0.5;

// The canvas overscans the rail so sparks thrown off the beam aren't clipped;
// the fill is still drawn only inside the rail band (offset by OVERSCAN_TOP).
const OVERSCAN_TOP = 15; // px above the rail
const OVERSCAN_BOTTOM = 15; // px below the rail
const OVERSCAN_RIGHT = 14; // px past the rail's right edge (ahead of the beam)

// Tier thresholds on the canonical scale (index / 5): xhigh 0.6, max 0.8,
// ultra 1.0. Each tier's drive is 0 at its threshold and 1 at ultra, so a
// drag ramps every effect in rather than switching it on.
const HOT_ON = 0.5; // white-hot edge + sparks (0.2 at xhigh, 0.6 at max)
const SURGE_ON = 0.7; // brightness waves (0.33 at max)
const CHAOS_ON = 0.9; // tears, blowouts, lightning (ultra only)

// White-hot edge: the last EDGE_CELLS columns of the fill bleach toward white,
// flickering, in proportion to the hot drive.
const EDGE_CELLS = 6;
const EDGE_WHITE = 0.85; // max white mix at the very edge at full heat

// Surges: sine waves of brightness rolling through the fill faster than the
// current itself, so max reads as pulsing rather than merely fast.
const SURGE_WAVELENGTH = 0.06; // radians per px
const SURGE_SPEED = 0.011; // radians per ms
const SURGE_DEPTH = 0.6; // ± intensity swing at full drive

// Sparks: pixels ejected off the leading edge, arcing under gravity.
const SPARK_RATE = 7; // sparks spawned per ~16ms frame at ultra
const SPARK_SPEED = 0.055; // base ejection velocity (px/ms)
const SPARK_LIFE = 620; // ms before a spark fully fades
const SPARK_GRAVITY = 0.00016; // px/ms² downward pull, so arcs curve back down
const SPARK_MAX = 360; // hard cap on live sparks
const SPARK_SPREAD = Math.PI * 0.82; // half-fan (±) around the +x axis: right, up, down, diagonals

// Chaos: per-row shear (tears) held for TEAR_HOLD, random cells flashing
// white (blowouts) or vanishing (dropouts), and lightning bolts — short jagged
// runs of white cells jumping off the edge — that linger a couple of paints.
const TEAR_CHANCE = 0.09; // per row per paint at full chaos
const TEAR_MAX_CELLS = 3;
const TEAR_HOLD = 140; // ms a shear holds before the row snaps back
const BLOWOUT_CHANCE = 0.025; // per cell per paint at full chaos
const DROPOUT_CHANCE = 0.05;
const BOLT_CHANCE = 0.16; // per paint at full chaos
const BOLT_LIFE = 110; // ms
const BOLT_MIN_CELLS = 5;
const BOLT_MAX_CELLS = 11;

type Spark = { x: number; y: number; vx: number; vy: number; life: number; size: number };
type Bolt = { cells: number[]; life: number }; // flat [x, y, x, y, …] in canvas px

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function drive(heat: number, on: number): number {
  return clamp01((heat - on) / (1 - on));
}

export function EffortPixelField({ level, heat }: { level: number; heat: number }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);
  const heatRef = useRef(heat);

  // Live values the rAF loop reads without re-running its setup effect.
  useEffect(() => {
    levelRef.current = level;
    heatRef.current = heat;
  }, [level, heat]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // "White-hot" is relative to the rail: on a dark rail the hottest cells
    // bleach toward white, on a light one they burn toward the ink — white
    // cells on a pale rail would simply vanish.
    const readHotInk = (): Rgb => {
      const rail = readColorToken("--panel-sunken", host);
      return luminance(rail) > 0.5 ? readColorToken("--text", host) : { r: 255, g: 255, b: 255 };
    };
    let accent: Rgb = readColorToken("--accent", host);
    let crest: Rgb = readColorToken("--accent-deep", host);
    let hotInk: Rgb = readHotInk();
    let railW = 0; // the rail's own width/height (the track element)
    let railH = 0;
    let width = 0; // the canvas' overscanned size
    let height = 0;
    let raf = 0;
    let running = false;
    let shownLevel = levelRef.current; // eased fill, so snaps glide instead of jumping
    let shownHeat = heatRef.current; // eased heat, so a step change ramps up/down
    let scroll = 0; // accumulated flow phase (advanced by dt*rate, never now*rate)
    let surgePhase = 0;
    let frame = 0; // paint counter, seeds the per-paint chaos hashes
    let last = 0;
    let lastPaint = 0;
    let pendingDt = 0; // wall-clock accumulated across skipped (throttled) frames
    const sparks: Spark[] = [];
    const bolts: Bolt[] = [];
    let tearShift: number[] = []; // per row, in cells
    let tearTtl: number[] = []; // per row, ms left on the shear

    const resize = (): void => {
      railW = host.clientWidth;
      railH = host.clientHeight;
      width = railW + OVERSCAN_RIGHT;
      height = railH + OVERSCAN_TOP + OVERSCAN_BOTTOM;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const rows = Math.ceil(railH / CELL);
      tearShift = new Array<number>(rows).fill(0);
      tearTtl = new Array<number>(rows).fill(0);
    };
    resize();

    const fill = (color: Rgb, white: number, alpha: number): void => {
      // Push toward the hot ink by `white` (0..1); sparks and the hot edge use it.
      const r = Math.round(color.r + (hotInk.r - color.r) * white);
      const g = Math.round(color.g + (hotInk.g - color.g) * white);
      const b = Math.round(color.b + (hotInk.b - color.b) * white);
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    };

    const advanceTears = (dt: number, chaos: number): void => {
      for (let r = 0; r < tearShift.length; r += 1) {
        if ((tearTtl[r] ?? 0) > 0) {
          tearTtl[r] = (tearTtl[r] ?? 0) - dt;
          if ((tearTtl[r] ?? 0) <= 0) tearShift[r] = 0;
        } else if (chaos > 0 && Math.random() < chaos * TEAR_CHANCE) {
          const magnitude = 1 + Math.floor(Math.random() * TEAR_MAX_CELLS);
          tearShift[r] = Math.random() < 0.5 ? -magnitude : magnitude;
          tearTtl[r] = TEAR_HOLD * (0.5 + Math.random());
        }
      }
    };

    // The rail sits inside the overscanned canvas, pushed down by OVERSCAN_TOP.
    const drawFill = (hot: number, surge: number, chaos: number): void => {
      const fillWidth = railW * shownLevel;
      if (fillWidth <= 0.5) return;
      const cols = Math.ceil(railW / CELL);
      const rows = Math.ceil(railH / CELL);
      // Brightness climbs with effort, so the accent starts muted and grows vivid.
      const bright = BRIGHT_FLOOR + (1 - BRIGHT_FLOOR) * shownHeat;
      const edgeSpan = EDGE_CELLS * CELL;

      for (let r = 0; r < rows; r += 1) {
        const shift = (tearShift[r] ?? 0) * CELL;
        for (let c = 0; c < cols; c += 1) {
          const x = c * CELL;
          if (x >= fillWidth) break; // only the filled portion is pixelated
          if (chaos > 0 && hash(c * 1.3 + frame * 0.37, r * 2.1 + frame * 0.11) < chaos * DROPOUT_CHANCE) {
            continue; // a cell that failed to paint this frame
          }
          const w = mosaicWeight(c, r, scroll);
          // Ramp brighter toward the fill edge (right), fainter at the start.
          const ramp = 0.2 + 0.8 * (x / fillWidth);
          let intensity = ramp * (FLOOR + (1 - FLOOR) * w) * mosaicJitter(c, r) * bright;
          if (surge > 0) {
            const wave = Math.sin(x * SURGE_WAVELENGTH - surgePhase + r * 0.35);
            intensity *= 1 + surge * SURGE_DEPTH * wave;
          }
          if (intensity > INTENSITY_CAP) intensity = INTENSITY_CAP;
          if (intensity < 0.02) continue;
          let white = 0;
          if (hot > 0) {
            // Bleach the trailing cells before the edge, flickering with a
            // faster, finer current than the mosaic's own.
            const near = clamp01(1 - (fillWidth - x) / edgeSpan);
            if (near > 0) {
              const flicker = 0.45 + 0.55 * vnoise(c * 0.9 - scroll * 3.2, r + 7.3);
              white = EDGE_WHITE * hot * near * near * flicker;
              intensity = Math.min(1, intensity + white * 0.5);
            }
          }
          if (chaos > 0 && hash(c * 0.61 + frame * 0.23, r * 1.7 + frame * 0.41) < chaos * BLOWOUT_CHANCE) {
            white = 0.8;
            intensity = 1;
          }
          fill(mosaicColor(w, accent, crest), white, intensity);
          ctx.fillRect(x + shift, OVERSCAN_TOP + r * CELL, CELL - 1, CELL - 1);
        }
      }
    };

    const spawnSpark = (hot: number, chaos: number): void => {
      const edgeX = railW * shownLevel;
      // At ultra a share of sparks erupt from inside the fill, in every
      // direction; otherwise they fan off the edge, centred on +x.
      const fromWithin = chaos > 0 && Math.random() < chaos * 0.25;
      const spread = fromWithin ? Math.PI : SPARK_SPREAD;
      const angle = (Math.random() * 2 - 1) * spread;
      const vel = SPARK_SPEED * (0.5 + Math.random()) * (1 + chaos * 0.7);
      sparks.push({
        x: fromWithin ? Math.random() * edgeX : edgeX + (Math.random() * 2 - 1) * 2,
        y: OVERSCAN_TOP + Math.random() * railH,
        vx: Math.cos(angle) * vel,
        vy: Math.sin(angle) * vel,
        life: SPARK_LIFE * (0.6 + 0.5 * Math.random()) * (1 + chaos * 0.4),
        size: !fromWithin && chaos > 0 && Math.random() < chaos * 0.2 ? 2 : 1
      });
    };

    const updateSparks = (dt: number, hot: number, chaos: number): void => {
      let load = Math.pow(hot, 1.5) * SPARK_RATE * (dt / 16);
      while (load > 0 && sparks.length < SPARK_MAX) {
        if (load >= 1 || Math.random() < load) spawnSpark(hot, chaos);
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
        const remaining = s.life / SPARK_LIFE;
        const alpha = Math.min(0.9, remaining * 0.95);
        // Young sparks leave white-hot and cool to the crest as they fade.
        fill(crest, hot * clamp01(remaining - 0.3), alpha);
        const side = s.size * CELL - 1;
        ctx.fillRect(Math.round(s.x), Math.round(s.y), side, side);
      }
    };

    const spawnBolt = (): void => {
      const edgeCol = Math.floor((railW * shownLevel) / CELL);
      const rows = Math.ceil(railH / CELL);
      // Rows may run into the overscan band above and below the rail.
      let row = Math.floor(Math.random() * rows);
      const cells: number[] = [];
      const length = BOLT_MIN_CELLS + Math.floor(Math.random() * (BOLT_MAX_CELLS - BOLT_MIN_CELLS + 1));
      const backward = Math.random() < 0.35; // some bolts strike back into the fill
      for (let i = 0; i < length; i += 1) {
        const col = backward ? edgeCol - i : edgeCol + i;
        cells.push(col * CELL, OVERSCAN_TOP + row * CELL);
        row += Math.floor(Math.random() * 3) - 1;
      }
      bolts.push({ cells, life: BOLT_LIFE });
    };

    const updateBolts = (dt: number, chaos: number): void => {
      if (chaos > 0 && Math.random() < chaos * BOLT_CHANCE) spawnBolt();
      for (let i = bolts.length - 1; i >= 0; i -= 1) {
        const bolt = bolts[i];
        if (!bolt) continue;
        bolt.life -= dt;
        if (bolt.life <= 0) {
          bolts.splice(i, 1);
          continue;
        }
        const alpha = 0.55 + 0.45 * (bolt.life / BOLT_LIFE);
        fill(crest, 0.9, alpha);
        for (let k = 0; k + 1 < bolt.cells.length; k += 2) {
          ctx.fillRect(bolt.cells[k] ?? 0, bolt.cells[k + 1] ?? 0, CELL - 1, CELL - 1);
        }
      }
    };

    const paint = (step: number): void => {
      const hot = drive(shownHeat, HOT_ON);
      const surge = drive(shownHeat, SURGE_ON);
      const chaos = drive(shownHeat, CHAOS_ON);
      frame += 1;
      ctx.clearRect(0, 0, width, height);
      advanceTears(step, chaos);
      drawFill(hot, surge, chaos);
      updateBolts(step, chaos);
      updateSparks(step, hot, chaos);
    };

    // Static paint for reduced motion: settle to the target level, no flow, no
    // sparks, tears or bolts (they all read as motion).
    const paintStatic = (): void => {
      shownLevel = levelRef.current;
      shownHeat = heatRef.current;
      sparks.length = 0;
      bolts.length = 0;
      tearShift.fill(0);
      tearTtl.fill(0);
      ctx.clearRect(0, 0, width, height);
      drawFill(drive(shownHeat, HOT_ON), 0, 0);
    };

    const tick = (): void => {
      // A backgrounded tab gains nothing from new frames and rAF may be
      // throttled to 1 Hz there anyway — park the loop until visible again
      // rather than burning CPU on invisible pixels.
      if (document.hidden) {
        running = false;
        raf = 0;
        return;
      }
      const now = performance.now();
      const dt = last === 0 ? 16 : Math.min(64, now - last);
      last = now;
      shownLevel += (levelRef.current - shownLevel) * 0.2;
      shownHeat += (heatRef.current - shownHeat) * 0.2;
      // Decorative flow at ~30 fps is indistinguishable from 60 fps here and
      // halves the per-cell noise cost, the dominant term in this loop. The
      // skipped frames' wall-clock still counts toward motion so the flow
      // rate and spark physics don't run at half speed.
      pendingDt += dt;
      if (now - lastPaint >= 33) {
        lastPaint = now;
        const step = pendingDt;
        pendingDt = 0;
        const chaos = drive(shownHeat, CHAOS_ON);
        const rate = (BASE_SPEED + SPEED_RANGE * Math.pow(shownHeat, SPEED_CURVE)) * (1 + chaos * 0.5);
        scroll += step * rate;
        surgePhase += step * SURGE_SPEED;
        paint(step);
      }
      raf = requestAnimationFrame(tick);
    };

    const start = (): void => {
      if (running || document.hidden) return;
      running = true;
      raf = requestAnimationFrame(tick);
    };

    if (reduceMotion) paintStatic();
    else start();

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reduceMotion) paintStatic();
    });
    resizeObserver.observe(host);

    // Refresh colors when the theme or accent attribute flips on <html>.
    const themeObserver = new MutationObserver(() => {
      accent = readColorToken("--accent", host);
      crest = readColorToken("--accent-deep", host);
      hotInk = readHotInk();
      if (reduceMotion) paintStatic();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent"]
    });

    const onVisibility = (): void => {
      if (!reduceMotion && !document.hidden) {
        last = 0;
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      running = false;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={canvasRef} className="effort-pixel-field" aria-hidden="true" />;
}
