import { ChevronRight } from "lucide-react";
import { useState, type JSX, type ReactNode } from "react";

/**
 * Collapsible "Thought" block for Claude's extended-thinking (reasoning).
 * The normalizer surfaces thinking as a message.delta with
 * payload.thinking === true; the turn folder routes those groups here instead
 * of rendering them as inline answer text.
 *
 * While the turn is actively working and hasn't produced its answer yet the
 * parent passes `live`, and the block shows the reasoning expanded (labelled
 * "Thinking") in place of the generic thinking-verb animation. Once the answer
 * lands (or the turn ends) `live` flips off and the block follows the saved
 * expanded-by-default setting. A manual toggle overrides the auto behavior
 * (same pattern as the turn chip).
 */
export function ThoughtBlock({
  children,
  defaultExpanded = false,
  live = false
}: {
  children: ReactNode;
  defaultExpanded?: boolean;
  live?: boolean;
}): JSX.Element {
  const [userToggle, setUserToggle] = useState<boolean | null>(null);
  const expanded = userToggle ?? (live || defaultExpanded);
  return (
    <div className="thought-block" data-live={live ? "true" : undefined}>
      <button
        type="button"
        className="thought-block-toggle"
        aria-expanded={expanded}
        aria-label="Reasoning"
        title={expanded ? "Hide reasoning" : "Show reasoning"}
        onClick={() => setUserToggle(!expanded)}
      >
        <span className="thought-block-label">{live ? "Thinking" : "Thought"}</span>
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
