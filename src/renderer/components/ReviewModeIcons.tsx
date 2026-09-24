// Boxed glyphs for the review panel's mode tabs, drawn on lucide's 24px grid
// and stroke so they sit beside its icons. The box corner is rounder than
// lucide's rx=2 square icons, matching the tab pills around them.

import type { JSX } from "react";

const BOX = { x: 3, y: 3, width: 18, height: 18, rx: 5 };

function BoxedIcon({ size, children }: { size: number; children: JSX.Element }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect {...BOX} />
      {children}
    </svg>
  );
}

/** Additions over deletions: what the Changes tab lists, not the branch it sits on. */
export function ChangesIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <BoxedIcon size={size}>
      <path d="M12 7.5v5M9.5 10h5M9.5 16h5" />
    </BoxedIcon>
  );
}

export function TerminalIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <BoxedIcon size={size}>
      <path d="m8 9.5 2.5 2.5L8 14.5M13 15h3" />
    </BoxedIcon>
  );
}
