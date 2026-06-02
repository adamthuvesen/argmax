import { useState, type JSX, type ReactNode } from "react";

/**
 * Collapsible "Thought" block for Claude's extended-thinking (reasoning).
 * The normalizer surfaces thinking as a message.delta with
 * payload.thinking === true; the turn folder routes those groups here instead
 * of rendering them as inline answer text.
 *
 * Speaks the same disclosure vocabulary as ToolCallGroupBubble — an uppercase
 * mono eyebrow + a `+`/`−` toggle + a left rail on the body — so reasoning and
 * tool work read as one consistent set of foldable sections within a turn.
 * The eyebrow stays neutral-muted (not the tool groups' sage) so reasoning
 * reads as a quieter sibling, subordinate to the actual work and the answer.
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
    <div
      className="thought-block"
      data-live={live ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
    >
      <button
        type="button"
        className="thought-block-header"
        aria-expanded={expanded}
        aria-label="Reasoning"
        title={expanded ? "Hide reasoning" : "Show reasoning"}
        onClick={() => setUserToggle(!expanded)}
      >
        <span className="thought-block-eyebrow" aria-hidden="true">
          <span className="thought-block-eyebrow-label">{live ? "Thinking" : "Thought"}</span>
        </span>
        <span
          className={`thought-block-toggle${expanded ? " expanded" : ""}`}
          aria-hidden="true"
        >
          {expanded ? "−" : "+"}
        </span>
      </button>
      {expanded ? <div className="thought-block-body">{children}</div> : null}
    </div>
  );
}
