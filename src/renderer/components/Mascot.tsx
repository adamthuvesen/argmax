import { useEffect, useRef, useState, type JSX, type MouseEvent } from "react";

export type MascotMood = "idle" | "thinking" | "happy" | "sad" | "working";

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
  idle: "Invader mascot",
  thinking: "Invader mascot, thinking",
  happy: "Invader mascot, cheering",
  sad: "Invader mascot, looking concerned",
  working: "Invader mascot, working"
};

// 16 cols × 12 rows. X = body, E = eye, . = transparent.
// Rectangular head, straight antennae, arms protruding 1px gap from body,
// four splayed legs with pointy feet — silhouette inspired by 👾.
const BODY: ReadonlyArray<string> = [
  "....X......X....",
  "....X......X....",
  "..XXXXXXXXXXXX..",
  "..XXXXXXXXXXXX..",
  "..XEE.XXXX.EEX..",
  "..XEE.XXXX.EEX..",
  "..XXXXXXXXXXXX..",
  "XX.XXXXXXXXXX.XX",
  "XX.XXXXXXXXXX.XX",
  "..XXXXXXXXXXXX..",
  ".XX..XX..XX..XX.",
  ".X....X..X....X."
];

const GRID_W = 16;
const GRID_H = 16;
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
  const bodyRects: JSX.Element[] = [];
  const eyeRects: JSX.Element[] = [];

  BODY.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      const cell = row.charAt(x);
      if (cell === "X") {
        bodyRects.push(<rect key={`b-${x}-${y}`} x={x} y={y} width={1} height={1} />);
      } else if (cell === "E") {
        eyeRects.push(<rect key={`e-${x}-${y}`} x={x} y={y} width={1} height={1} />);
      }
    }
  });

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
      viewBox={`0 0 ${GRID_W} ${GRID_H}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g className="mascot-fill">{bodyRects}</g>
      <g className="mascot-eyes">{eyeRects}</g>
      <g className="mascot-rain" aria-hidden="true">
        <rect className="mascot-rain-dot mascot-rain-dot-1" x={4} y={13} width={1} height={1} />
        <rect className="mascot-rain-dot mascot-rain-dot-2" x={8} y={13} width={1} height={1} />
        <rect className="mascot-rain-dot mascot-rain-dot-3" x={12} y={13} width={1} height={1} />
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
