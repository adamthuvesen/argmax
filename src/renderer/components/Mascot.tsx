import { useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import { useMascotVisible } from "../lib/mascotVisibility.js";
import baseSprite from "../../../assets/fox-mascot.txt?raw";
import winkSprite from "../../../assets/fox-mascot-wink.txt?raw";
import sleepySprite from "../../../assets/fox-mascot-sleepy.txt?raw";
import shadesSprite from "../../../assets/fox-mascot-shades.txt?raw";

export type MascotMood = "idle" | "sleepy" | "sad";

/** Which drawing is on screen. The base sprite is also the app icon source;
 *  the other three are expressions the launcher fox reaches for. */
type SpriteName = "base" | "wink" | "sleepy" | "shades";

interface MascotProps {
  mood?: MascotMood;
  size?: number;
  label?: string;
  className?: string;
  buttonClassName?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  /** Sunglasses, earned by petting. Outranks every expression: the shades
   *  cover the eyes, so wink and sleepy have nothing left to show. */
  shades?: boolean;
}

const MOOD_LABEL: Record<MascotMood, string> = {
  idle: "Fox mascot",
  sleepy: "Fox mascot, dozing",
  sad: "Fox mascot, looking concerned"
};

const SHADES_LABEL = "Fox mascot, in sunglasses";

function parseGrid(source: string): ReadonlyArray<string> {
  return source.split("\n").filter((row) => row !== "" && !row.startsWith("#"));
}

// All four sprites share one 56x40 grid and one palette, so the viewBox comes
// off the base drawing and holds for every expression.
const GRID: ReadonlyArray<string> = parseGrid(baseSprite);
const GRID_W = GRID[0].length;

// The sprite is wide and short, so the viewBox is squared off below it: the fox
// keeps the top of a square mark, and callers still size it with one number.
const VIEW = GRID_W;

// Each palette character becomes one <g>, and CSS owns the colours from there.
// `w` is grouped last so the eye highlights paint over the outline blocks.
const LAYERS: ReadonlyArray<{ cell: string; className: string }> = [
  { cell: "K", className: "mascot-line" },
  { cell: "o", className: "mascot-fur" },
  { cell: "d", className: "mascot-fur-shade" },
  { cell: "c", className: "mascot-cream" },
  { cell: "t", className: "mascot-cream-shade" },
  { cell: "x", className: "mascot-nose" },
  { cell: "p", className: "mascot-blush" },
  { cell: "w", className: "mascot-eyes" }
];

interface SpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Greedy maximal-rectangle cover of every cell in `grid` holding `cell`. The
 * sprites are drawn at 2x, so merging vertically as well as horizontally more
 * than halves the geometry: ~128 rects across all the layers of one sprite
 * instead of 316 runs.
 */
function coverCells(grid: ReadonlyArray<string>, cell: string): SpriteRect[] {
  const taken = grid.map(() => new Array<boolean>(GRID_W).fill(false));
  const rects: SpriteRect[] = [];

  const free = (x: number, y: number): boolean => !taken[y][x] && grid[y].charAt(x) === cell;
  const rowFree = (y: number, from: number, to: number): boolean => {
    for (let x = from; x <= to; x += 1) {
      if (!free(x, y)) return false;
    }
    return true;
  };

  for (let y = 0; y < grid.length; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      if (!free(x, y)) continue;
      let right = x;
      while (right + 1 < GRID_W && free(right + 1, y)) right += 1;
      let bottom = y;
      while (bottom + 1 < grid.length && rowFree(bottom + 1, x, right)) bottom += 1;
      for (let row = y; row <= bottom; row += 1) {
        for (let col = x; col <= right; col += 1) taken[row][col] = true;
      }
      rects.push({ x, y, width: right - x + 1, height: bottom - y + 1 });
    }
  }
  return rects;
}

type SpriteLayers = ReadonlyArray<{ className: string; rects: SpriteRect[] }>;

function layersFor(source: string): SpriteLayers {
  const grid = parseGrid(source);
  return LAYERS.map(({ cell, className }) => ({ className, rects: coverCells(grid, cell) }));
}

// Built once at module load, not per render: the sprites never change.
const SPRITE_LAYERS: Record<SpriteName, SpriteLayers> = {
  base: layersFor(baseSprite),
  wink: layersFor(winkSprite),
  sleepy: layersFor(sleepySprite),
  shades: layersFor(shadesSprite)
};

const PET_DURATION_MS = 700;

function spriteFor(mood: MascotMood, isPet: boolean, shades: boolean): SpriteName {
  if (shades) return "shades";
  if (isPet) return "wink";
  return mood === "sleepy" ? "sleepy" : "base";
}

export function Mascot({
  mood = "idle",
  size = 64,
  label,
  className,
  buttonClassName,
  onClick,
  type = "button",
  disabled,
  title,
  shades = false
}: MascotProps): JSX.Element | null {
  const ariaLabel = label ?? (shades ? SHADES_LABEL : MOOD_LABEL[mood]);
  const classes = ["mascot", className].filter(Boolean).join(" ");

  const visible = useMascotVisible();
  const [isPet, setIsPet] = useState(false);
  const petTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (petTimerRef.current !== null) {
        clearTimeout(petTimerRef.current);
        petTimerRef.current = null;
      }
    };
  }, []);

  // Settings → Appearance → Fox mascot. Gated here rather than at each call
  // site so one switch reaches every fox; the hooks above still run, so the
  // pet timer keeps its cleanup when the fox is turned off mid-hop.
  if (!visible) return null;

  const spriteName = spriteFor(mood, isPet, shades);

  const svg = (
    <svg
      className={classes}
      data-mood={mood}
      data-sprite={spriteName}
      data-pet={isPet ? "true" : undefined}
      role="img"
      aria-label={ariaLabel}
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      {SPRITE_LAYERS[spriteName].map(({ className: layerClass, rects }) => (
        // The key carries the sprite so switching expression swaps whole rect
        // sets instead of repointing the ones that happen to line up.
        <g className={layerClass} key={`${spriteName}-${layerClass}`}>
          {rects.map((rect) => (
            <rect
              key={`${rect.x}-${rect.y}`}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
            />
          ))}
        </g>
      ))}
    </svg>
  );

  const renderAsButton = Boolean(onClick) || type === "submit";

  if (renderAsButton) {
    const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
      if (petTimerRef.current !== null) {
        clearTimeout(petTimerRef.current);
      }
      setIsPet(true);
      petTimerRef.current = setTimeout(() => {
        setIsPet(false);
        petTimerRef.current = null;
      }, PET_DURATION_MS);
      onClick?.(event);
    };

    const buttonClasses = ["mascot-button", buttonClassName].filter(Boolean).join(" ");

    return (
      <button
        type={type}
        className={buttonClasses}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={handleClick}
      >
        {svg}
      </button>
    );
  }

  return svg;
}
