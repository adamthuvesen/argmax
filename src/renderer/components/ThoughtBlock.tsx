import { ChevronRight } from "lucide-react";
import { useEffect, useState, type JSX, type ReactNode } from "react";
import { formatThoughtLabel } from "../formatElapsed.js";

/**
 * Collapsible "Thought" block for Claude's extended-thinking (reasoning).
 * The normalizer surfaces thinking as a message.delta with
 * payload.thinking === true; the turn folder routes those groups here instead
 * of rendering them as inline answer text.
 *
 * Speaks the same disclosure vocabulary as the turn/tool rows — a quiet label
 * and chevron — so reasoning and tool work read as one consistent set of
 * foldable sections within a turn. The label stays neutral-muted (not the tool
 * groups' sage) so reasoning reads as a quieter sibling, subordinate to the
 * actual work and the answer.
 *
 * While the turn is actively working and hasn't produced its answer yet the
 * parent passes `live`, and the block shows the reasoning expanded (labelled
 * "Thinking") in place of the generic Thinking indicator. Once the answer
 * lands (or the turn ends) `live` flips off: the label settles to "Thought",
 * and `holdOpen` decides whether the body stays open or follows the saved
 * expanded-by-default setting. A manual toggle overrides the auto behavior
 * (same pattern as the turn chip) and survives until that auto answer itself
 * changes.
 */
type UserToggle = {
  value: boolean;
  autoExpanded: boolean;
};

export function ThoughtBlock({
  children,
  defaultExpanded = false,
  live = false,
  holdOpen = false,
  durationMs
}: {
  children: ReactNode;
  defaultExpanded?: boolean;
  live?: boolean;
  /** Keep a block that opened itself while live open after `live` ends. */
  holdOpen?: boolean;
  durationMs?: number;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  // A block that opened itself while the reasoning was live must not fold back
  // in place. Its whole height would leave the transcript at the instant the
  // first answer token lands, and a reader pinned to the bottom is pulled up by
  // exactly that much, mid-stream. `holdOpen` keeps it open until the caller
  // says the moment has passed. For a turn, hold it until it stops being the newest
  // one, where the fold sits above a viewport full of the answer.
  const [openedLive, setOpenedLive] = useState(live);
  useEffect(() => {
    if (live) setOpenedLive(true);
  }, [live]);
  const autoExpanded = live || (holdOpen && openedLive) || defaultExpanded;
  const expanded = userToggle?.autoExpanded === autoExpanded ? userToggle.value : autoExpanded;
  const label = formatThoughtLabel(live, durationMs);
  const titleVerb = live ? "thinking" : "thought";
  return (
    <div
      className="thought-block"
      data-live={live ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
    >
      <button
        type="button"
        className="thought-block-header"
        aria-expanded={expanded}
        aria-label={label}
        title={expanded ? `Hide ${titleVerb}` : `Show ${titleVerb}`}
        onClick={() => setUserToggle({ value: !expanded, autoExpanded })}
      >
        <span className="thought-block-eyebrow">
          <span className="thought-block-eyebrow-label">{label}</span>
        </span>
        <ChevronRight
          size={12}
          className={`thought-block-chevron${expanded ? " expanded" : ""}`}
          aria-hidden="true"
        />
      </button>
      {expanded ? <div className="thought-block-body">{children}</div> : null}
    </div>
  );
}
