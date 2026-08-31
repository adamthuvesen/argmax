import { useState, type JSX } from "react";
import { contextWindowForModel } from "../../shared/providerModels.js";
import type { SessionSummary } from "../../shared/types.js";
import { useAnchoredPopover } from "../hooks/useAnchoredPopover.js";
import { useDismissOnOutsideOrEscape } from "../hooks/useDismissOnOutsideOrEscape.js";

// Dial proportions, not spinner proportions. A thin arc with round caps on a
// faint track is exactly how an indeterminate spinner is drawn, so at 15px the
// old r6/2.5/round ring read as "loading" rather than "this much of the window
// is used". A thick stroke against a solid track, with flat ends, reads as a
// gauge: the hole stays open enough to keep it light beside 14px text.
const RADIUS = 5.4;
const STROKE = 3.4;
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
  // Same anchoring as every other composer popover: near edge to near edge,
  // flipping only when the panel would leave the viewport. See the note on
  // .context-ring-popover in chat-tools.css.
  const flyout = useAnchoredPopover({ open, placement: "bottom-start", strategy: "absolute" });
  useDismissOnOutsideOrEscape(flyout.anchorRef, open, () => setOpen(false));

  const used = session.contextTokens ?? 0;
  // Every provider falls back to the model table when the session row carries
  // no window. Codex used to be carved out of this on the grounds that it
  // reports its own — it does, but only inside `event_msg`/`token_count` rows,
  // which `codex exec --json` stopped emitting. The carve-out then meant a
  // silently missing ring rather than an approximate one.
  const windowSize = session.contextWindow ?? contextWindowForModel(session.modelId);
  if (!windowSize || windowSize <= 0 || used <= 0) return null;

  const fraction = Math.min(1, used / windowSize);
  const percent = Math.round(fraction * 100);
  const remaining = Math.max(0, windowSize - used);
  const color = fillColor(fraction);
  // Past the amber threshold the headroom figure takes the fill's hue: one
  // hue, stated once, on the line the user reads first.
  const pressured = fraction >= 0.75;
  const label = `Context window ${percent}% full — ${used.toLocaleString()} of ${windowSize.toLocaleString()} tokens`;

  return (
    <div className="context-ring-anchor" ref={flyout.setAnchor}>
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
          <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="var(--line)" strokeWidth={STROKE} />
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            transform="rotate(-90 8 8)"
          />
        </svg>
      </button>
      {open && (
        <div
          className="context-ring-popover"
          role="dialog"
          aria-label="Context window usage"
          ref={flyout.setPopover}
          style={flyout.floatingStyles}
        >
          {/* Headroom leads: it is the number that changes what the user does
              next. Percentages and exact counts are the same fact told less
              usefully — the bar carries the proportion, and the trigger's
              title keeps the precise figures for anyone who wants them. */}
          <p className="context-ring-headroom" style={pressured ? { color } : undefined}>
            {formatCompact(remaining)} left
          </p>
          <div className="context-ring-bar" aria-hidden="true">
            <span style={{ width: `${fraction * 100}%`, background: color }} />
          </div>
          <p className="context-ring-meta">
            {formatCompact(used)} of {formatCompact(windowSize)} used · {session.modelLabel}
          </p>
        </div>
      )}
    </div>
  );
}
