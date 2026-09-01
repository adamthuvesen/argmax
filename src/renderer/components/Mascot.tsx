import { useEffect, useRef, useState, type JSX, type MouseEvent } from "react";
import sprite from "../../../assets/fox-mascot.txt?raw";

export type MascotMood = "idle" | "thinking" | "happy" | "sad";

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
}

const MOOD_LABEL: Record<MascotMood, string> = {
  idle: "Fox mascot",
  thinking: "Fox mascot, thinking",
  happy: "Fox mascot, cheering",
  sad: "Fox mascot, looking concerned"
};

const GRID: ReadonlyArray<string> = sprite.split("\n").filter((row) => row !== "" && !row.startsWith("#"));
const GRID_W = GRID[0].length;
const GRID_H = GRID.length;

// The sprite is wide and short, so the viewBox is squared off below it: the fox
// keeps the top, and the thinking-mood rain falls into the space underneath.
// Callers size the mascot with one number, same as they always have.
const VIEW = GRID_W;
const RAIN_Y = GRID_H + 4;
const RAIN_SIZE = 3;

// Each palette character becomes one <g>, and CSS owns the colours from there.
// `w` is grouped last so the eye highlights paint over the outline blocks.
const LAYERS: ReadonlyArray<{ cell: string; className: string }> = [
  { cell: "K", className: "mascot-line" },
  { cell: "o", className: "mascot-fur" },
  { cell: "d", className: "mascot-fur-shade" },
  { cell: "c", className: "mascot-cream" },
  { cell: "t", className: "mascot-cream-shade" },
  { cell: "x", className: "mascot-nose" },
  { cell: "w", className: "mascot-eyes" }
];

interface SpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Greedy maximal-rectangle cover of every cell holding `cell`. The sprite is
 * drawn at 2x, so merging vertically as well as horizontally more than halves
 * the geometry: 128 rects across all seven layers instead of 316 runs.
 */
function coverCells(cell: string): SpriteRect[] {
  const taken = GRID.map(() => new Array<boolean>(GRID_W).fill(false));
  const rects: SpriteRect[] = [];

  const free = (x: number, y: number): boolean => !taken[y][x] && GRID[y].charAt(x) === cell;
  const rowFree = (y: number, from: number, to: number): boolean => {
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

// Built once at module load, not per render: the sprite never changes.
const LAYER_RECTS: ReadonlyArray<{ className: string; rects: SpriteRect[] }> = LAYERS.map(
  ({ cell, className }) => ({ className, rects: coverCells(cell) })
);

const PET_DURATION_MS = 700;

export function Mascot({
  mood = "idle",
  size = 64,
  label,
  className,
  buttonClassName,
  onClick,
  type = "button",
  disabled,
  title
}: MascotProps): JSX.Element {
  const ariaLabel = label ?? MOOD_LABEL[mood];
  const classes = ["mascot", className].filter(Boolean).join(" ");

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

  const svg = (
    <svg
      className={classes}
      data-mood={mood}
      data-pet={isPet ? "true" : undefined}
      role="img"
      aria-label={ariaLabel}
      width={size}
      height={size}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      {LAYER_RECTS.map(({ className: layerClass, rects }) => (
        <g className={layerClass} key={layerClass}>
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
      <g className="mascot-rain" aria-hidden="true">
        <rect
          className="mascot-rain-dot mascot-rain-dot-1"
          x={16}
          y={RAIN_Y}
          width={RAIN_SIZE}
          height={RAIN_SIZE}
        />
        <rect
          className="mascot-rain-dot mascot-rain-dot-2"
          x={26}
          y={RAIN_Y}
          width={RAIN_SIZE}
          height={RAIN_SIZE}
        />
        <rect
          className="mascot-rain-dot mascot-rain-dot-3"
          x={36}
          y={RAIN_Y}
          width={RAIN_SIZE}
          height={RAIN_SIZE}
        />
      </g>
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
