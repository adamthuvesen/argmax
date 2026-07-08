import { useRef, useState, type JSX } from "react";
import { contextWindowForModel } from "../../shared/providerModels.js";
import type { SessionSummary } from "../../shared/types.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Fill colour shifts as the window fills: accent while there's headroom, amber
// past 75%, rose near the ceiling. Uses the theme-aware status tokens so it
// stays correct in both light and dark modes.
function fillColor(fraction: number): string {
  if (fraction >= 0.9) return "var(--rose)";
  if (fraction >= 0.75) return "var(--amber)";
  return "var(--accent)";
}

function formatCompact(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

/**
 * Context-window occupancy for a session: a small ring showing how full the
 * model's context is, expanding on click to the exact token counts. Pure
 * projection of the session row (contextTokens / contextWindow), pushed on the
 * dashboard delta like the cost panel. Renders nothing when the window is
 * unknown or nothing has been used yet.
 */
export function ContextRing({ session }: { session: SessionSummary }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  useDismissOnOutsideOrEscape(anchorRef, open, () => setOpen(false));

  const used = session.contextTokens ?? 0;
  const windowSize = session.contextWindow ?? contextWindowForModel(session.modelId);
  if (!windowSize || windowSize <= 0 || used <= 0) return null;

  const fraction = Math.min(1, used / windowSize);
  const percent = Math.round(fraction * 100);
  const color = fillColor(fraction);
  const label = `Context window ${percent}% full — ${used.toLocaleString()} of ${windowSize.toLocaleString()} tokens`;

  return (
    <div className="context-ring-anchor" ref={anchorRef}>
      <button
        type="button"
        className="context-ring-trigger"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen((o) => !o)}
      >
        <svg className="context-ring-svg" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="var(--line)" strokeWidth="2.5" />
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open && (
        <div className="context-ring-popover" role="dialog" aria-label="Context window usage">
          <div className="context-ring-title">Context window</div>
          <div className="context-ring-headline">{percent}% full</div>
          <div className="context-ring-bar">
            <span style={{ width: `${fraction * 100}%`, background: color }} />
          </div>
          <div className="context-ring-tokens">
            {used.toLocaleString()} / {windowSize.toLocaleString()} tokens used
          </div>
          <div className="context-ring-model">
            {session.modelLabel} · {formatCompact(windowSize)} window
          </div>
        </div>
      )}
    </div>
  );
}
