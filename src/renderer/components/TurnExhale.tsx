import { useEffect, useRef, type CSSProperties, type JSX } from "react";
import { hash, luminance, readColorToken, vnoise, type Rgb } from "../lib/pixelField.js";

// The turn-end breath. When a turn finishes, a single wavefront of accent
// pixels sweeps left→right along the bottom edge of its card and dissolves.
//
// Same field as the composer backdrop and the effort rail (lib/pixelField.ts),
// so the app has one pixel language rather than three. What is new here is that
// the field carries a number: `weight` (0..1, from lib/turnExhale.ts) sets how
// far the front travels and how bright it burns. A one-line reply gets a short
// dim breath near the left edge; a turn that rewrote the repo crosses the whole
// card and throws sparks off the leading edge as it goes. So the size of what
// just happened is readable before any of it is.
//
// Cost: the canvas is mounted only for the ~1s it plays and the caller drops it
// on `onDone`, so a settled transcript of two hundred turns paints nothing and
// schedules no frames. Reduced motion and a hidden document skip it outright.

const CELL = 6; // logical px per pixel-cell, as in the composer field
// The breath hugs the bottom edge of the turn rather than filling it — the band
// height is `.turn-exhale`'s in chat-turns.css, and this canvas paints whatever
// it is handed. A long answer runs two thousand pixels tall, and a field behind
// all of it reads as a rendering fault rather than a flourish; the reader's eye,
// at the moment a turn lands, is at the bottom of it anyway.
const TAIL = 190; // px behind the front that stay lit
const FX = 0.3; // horizontal feature frequency (smaller = more individual pixels)
const FY = 0.8; // vertical feature frequency
const FLOOR = 0.3; // minimum fraction of intensity every cell gets (keeps it dense)
// Well under the composer field's 0.8: this paints behind live prose, and the
// breath has to stay a texture the answer sits on rather than a wash over it.
const INTEN_CAP = 0.72;
const DRIFT = 0.004; // slow scroll of the noise field, so the band is alive as it passes

// weight → the three things it controls. Each keeps a floor, because even the
// smallest turn gets punctuation; the floor is what "barely glows" means.
const REACH_FLOOR = 0.26; // fraction of the card width the front reaches at weight 0
const REACH_RANGE = 0.74; // …and the extra it reaches at weight 1 (so: edge to edge)
const STRENGTH_FLOOR = 0.28;
const STRENGTH_RANGE = 0.6;
// How tall the band is, in px. A small turn gets a thin ribbon along its bottom
// edge; a big one gets the full band. Height carries the weight as plainly as
// reach does, and it is what keeps a one-line reply from filling its whole card
// with field just because the card is short.
const BAND_FLOOR = 44;
const BAND_RANGE = 88;
// The accent is a low-chroma green, and on paper a low-alpha wash of it reads
// as grey dirt rather than a tint — the same alpha that carries the field on
// charcoal dissolves into white. So the field is matched by *strength*, not by
// alpha: a light page lifts the whole sweep. Probed from `--bg` rather than
// keyed to the theme attribute, so a future theme gets this for free.
const LIGHT_PAGE_LIFT = 1.9;
const LIGHT_PAGE_CAP = 0.85; // the lifted ceiling; the field must still sit under the ink
const DURATION_FLOOR = 620; // ms
const DURATION_RANGE = 620;
const FADE_FROM = 0.6; // fraction of the run after which the whole field fades out

// Sparks are the top-end payoff and nothing else: below this weight the breath
// is only a breath. Same idea as the effort rail's overheating leading edge,
// rationed harder — this fires on turn end, which happens all day.
const SPARK_ON = 0.62;
const SPARK_FROM = 0.5; // …and only in the back half of the sweep, as the front dies
const SPARK_RATE = 1.6; // max sparks spawned per frame at weight 1
const SPARK_SPEED = 0.05; // px/ms
const SPARK_LIFE = 520; // ms
const SPARK_GRAVITY = 0.00014; // px/ms², so arcs curve back down
const SPARK_SPREAD = Math.PI * 0.5; // half-fan (±) around the +x axis
const SPARK_MAX = 48;
const SPARK_SIZE = 3;

type Spark = { x: number; y: number; vx: number; vy: number; life: number };

export function TurnExhale({ weight, onDone }: { weight: number; onDone: () => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Held in a ref so a re-render of the turn (a hover, a sibling delta) can
  // never restart the sweep or leave a second loop running.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  // Read once, at mount: the sweep is sized by what the turn produced when it
  // ended, and nothing that happens during the next second changes that.
  const weightRef = useRef(weight);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return undefined;
    const finish = (): void => doneRef.current();

    // A breath nobody can see is just an idle draw, and one that can never
    // paint must still tell the caller to take the canvas away. All three of
    // these end the turn the same way a finished sweep would.
    const ctx = canvas.getContext("2d");
    if (!ctx || window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.hidden) {
      const id = window.setTimeout(finish, 0);
      return () => window.clearTimeout(id);
    }

    const w = Math.min(1, Math.max(0, weightRef.current));
    const reach = REACH_FLOOR + REACH_RANGE * w;
    const page = readColorToken("--bg", host);
    const lightPage = luminance(page) > 0.5;
    const strength = (STRENGTH_FLOOR + STRENGTH_RANGE * w) * (lightPage ? LIGHT_PAGE_LIFT : 1);
    // The ceiling rises with the strength, or a light page would clamp every
    // weight to the same alpha and the sweep would stop carrying its number.
    const cap = lightPage ? LIGHT_PAGE_CAP : INTEN_CAP;
    const duration = DURATION_FLOOR + DURATION_RANGE * w;
    const sparkRate = w > SPARK_ON ? ((w - SPARK_ON) / (1 - SPARK_ON)) * SPARK_RATE : 0;

    let accent: Rgb = readColorToken("--accent", host);
    let crest: Rgb = readColorToken("--accent-deep", host);
    let width = 0;
    let height = 0;
    let raf = 0;
    let lastFrame = 0;
    const sparks: Spark[] = [];

    const resize = (): void => {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();

    const draw = (now: number, t: number, dt: number): void => {
      ctx.clearRect(0, 0, width, height);
      // Out fast, then settling — an exhale, not a wipe.
      const travel = 1 - Math.pow(1 - t, 3);
      const front = travel * reach * width;
      const fade = t < FADE_FROM ? 1 : Math.max(0, 1 - (t - FADE_FROM) / (1 - FADE_FROM));
      const cols = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL);
      const scroll = now * DRIFT;

      for (let r = 0; r < rows; r += 1) {
        // The band is densest along the card's bottom edge and thins upward, so
        // it reads as something leaving the turn rather than a box drawn on it.
        const lift = (r + 1) / rows;
        if (lift < 0.04) continue;
        const sy = r * FY;
        for (let c = 0; c < cols; c += 1) {
          const behind = front - c * CELL;
          if (behind <= 0 || behind > TAIL) continue; // nothing ahead of the front, nothing past the tail
          const edge = 1 - behind / TAIL; // 1 at the leading edge, 0 at the tail
          const sx = c * FX - scroll;
          // Two octaves, contrast-stretched and floored: the same recipe the
          // composer field uses, so the two read as one material.
          let n = 0.55 * vnoise(sx, sy) + 0.45 * vnoise(sx * 2.6 - scroll * 0.9, sy * 1.8 + 11.3);
          n = (n - 0.5) * 1.7 + 0.5;
          if (n < 0) n = 0;
          else if (n > 1) n = 1;
          const jitter = 0.8 + 0.2 * hash(c * 0.7, r * 0.7);
          let intensity = strength * (FLOOR + (1 - FLOOR) * n) * edge * lift * fade * jitter;
          if (intensity > cap) intensity = cap;
          if (intensity < 0.02) continue;
          // The leading edge runs toward accent-deep, the way the working
          // nest's leader does — it is what makes the front a front.
          const mix = edge * edge;
          const cr = Math.round(accent.r + (crest.r - accent.r) * mix);
          const cg = Math.round(accent.g + (crest.g - accent.g) * mix);
          const cb = Math.round(accent.b + (crest.b - accent.b) * mix);
          ctx.fillStyle = `rgba(${cr},${cg},${cb},${intensity.toFixed(3)})`;
          ctx.fillRect(c * CELL, r * CELL, CELL - 1, CELL - 1);
        }
      }

      if (sparkRate > 0 && t > SPARK_FROM && front < width && sparks.length < SPARK_MAX) {
        // Fractional rate: the whole part always spawns, the remainder is the
        // odds of one more. A rate below 1/frame still produces a steady
        // trickle instead of rounding away to nothing.
        const spawn = sparkRate * (dt / 16);
        const count = Math.floor(spawn) + (Math.random() < spawn % 1 ? 1 : 0);
        for (let i = 0; i < count; i += 1) {
          if (sparks.length >= SPARK_MAX) break;
          const angle = (Math.random() * 2 - 1) * SPARK_SPREAD;
          const speed = SPARK_SPEED * (0.6 + Math.random() * 0.8);
          sparks.push({
            x: front,
            y: height - Math.random() * height * 0.55,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: SPARK_LIFE
          });
        }
      }

      for (let i = sparks.length - 1; i >= 0; i -= 1) {
        const spark = sparks[i];
        if (!spark) continue;
        spark.life -= dt;
        if (spark.life <= 0) {
          sparks.splice(i, 1);
          continue;
        }
        spark.x += spark.vx * dt;
        spark.y += spark.vy * dt;
        spark.vy += SPARK_GRAVITY * dt;
        const alpha = (spark.life / SPARK_LIFE) * fade * 0.8;
        if (alpha < 0.03) continue;
        ctx.fillStyle = `rgba(${crest.r},${crest.g},${crest.b},${alpha.toFixed(3)})`;
        ctx.fillRect(Math.round(spark.x), Math.round(spark.y), SPARK_SIZE, SPARK_SIZE);
      }
    };

    const startedAt = performance.now();
    lastFrame = startedAt;
    const tick = (): void => {
      const now = performance.now();
      const dt = Math.min(48, now - lastFrame);
      lastFrame = now;
      const t = (now - startedAt) / duration;
      if (t >= 1) {
        ctx.clearRect(0, 0, width, height);
        finish();
        return;
      }
      draw(now, t, dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    // A window hidden mid-sweep advances no animation frames, so the loop above
    // would never reach t >= 1 and the canvas would sit mounted forever. The
    // sweep's own length is the deadline; this is the only thing that ends it
    // if the frames stop arriving.
    const deadline = window.setTimeout(finish, duration + 200);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const themeObserver = new MutationObserver(() => {
      accent = readColorToken("--accent", host);
      crest = readColorToken("--accent-deep", host);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-accent"]
    });

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(deadline);
      resizeObserver.disconnect();
      themeObserver.disconnect();
    };
  }, []);

  // The band's height is the one visual the stylesheet cannot know, because it
  // is the weight. Everything else about the box stays in chat-turns.css.
  const band = BAND_FLOOR + BAND_RANGE * Math.min(1, Math.max(0, weight));
  return (
    <canvas
      ref={canvasRef}
      className="turn-exhale"
      style={{ "--turn-exhale-band": `${Math.round(band)}px` } as CSSProperties}
      aria-hidden="true"
    />
  );
}
