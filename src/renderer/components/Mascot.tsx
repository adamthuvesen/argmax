import type { JSX } from "react";

export type MascotMood = "idle" | "thinking" | "happy" | "sad" | "working";

interface MascotProps {
  mood?: MascotMood;
  size?: number;
  label?: string;
  className?: string;
}

const MOOD_LABEL: Record<MascotMood, string> = {
  idle: "Cloud mascot",
  thinking: "Cloud mascot, thinking",
  happy: "Cloud mascot, cheering",
  sad: "Cloud mascot, looking concerned",
  working: "Cloud mascot, working"
};

// 16 cols × 11 rows. X = cloud body, E = eye, . = transparent.
// Bumpy top edge + flat-ish belly reads as a "puff" silhouette at any size.
const BODY: ReadonlyArray<string> = [
  "....XXX..XXXX...",
  "..XXXXXXXXXXXX..",
  ".XXXXXXXXXXXXXX.",
  "XXXXXXXXXXXXXXXX",
  "XXXXXXXXXXXXXXXX",
  "XXXEEXXXXXXEEXXX",
  "XXXEEXXXXXXEEXXX",
  "XXXXXXXXXXXXXXXX",
  "XXXXXXXXXXXXXXXX",
  ".XXXXXXXXXXXXXX.",
  "..XXXXXXXXXXXX.."
];

// Three dangly legs hang from the cloud belly (rows 11-12).
const LEGS: ReadonlyArray<{ x: number; y: number; h: number }> = [
  { x: 3, y: 11, h: 2 },
  { x: 7, y: 11, h: 2 },
  { x: 12, y: 11, h: 2 }
];

const GRID_W = 16;
const GRID_H = 16; // 11 body + 2 legs + 3 rows of room for rain dots

export function Mascot({ mood = "idle", size = 64, label, className }: MascotProps): JSX.Element {
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

  return (
    <svg
      className={classes}
      data-mood={mood}
      role="img"
      aria-label={ariaLabel}
      width={size}
      height={size}
      viewBox={`0 0 ${GRID_W} ${GRID_H}`}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g className="mascot-legs">
        {LEGS.map(({ x, y, h }, i) => (
          <rect key={`l-${i}`} x={x} y={y} width={1} height={h} />
        ))}
      </g>
      <g className="mascot-fill">{bodyRects}</g>
      <g className="mascot-eyes">{eyeRects}</g>
      <g className="mascot-rain" aria-hidden="true">
        <rect className="mascot-rain-dot mascot-rain-dot-1" x={4} y={13} width={1} height={1} />
        <rect className="mascot-rain-dot mascot-rain-dot-2" x={8} y={13} width={1} height={1} />
        <rect className="mascot-rain-dot mascot-rain-dot-3" x={12} y={13} width={1} height={1} />
      </g>
    </svg>
  );
}
