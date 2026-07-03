import { ChevronRight } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

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
 * lands (or the turn ends) `live` flips off and the block follows the saved
 * expanded-by-default setting. A manual toggle overrides the auto behavior
 * (same pattern as the turn chip).
 */
type UserToggle = {
  value: boolean;
  defaultExpanded: boolean;
  live: boolean;
};

export function ThoughtBlock({
  children,
  defaultExpanded = false,
  live = false
}: {
  children: ReactNode;
  defaultExpanded?: boolean;
  live?: boolean;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<UserToggle | null>(null);
  const localExpanded =
    userToggle && userToggle.defaultExpanded === defaultExpanded && userToggle.live === live
      ? userToggle.value
      : null;
  const expanded = localExpanded ?? (live || defaultExpanded);
  const label = live ? "Thinking" : "Thought";
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
        title={expanded ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
        onClick={() => setUserToggle({ value: !expanded, defaultExpanded, live })}
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
