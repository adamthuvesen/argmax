import { Brain, ChevronRight } from "lucide-react";
import { useEffect, useState, type JSX, type ReactNode } from "react";
import { formatThoughtLabel } from "../formatElapsed.js";
import type { ThinkingDisplay } from "../lib/uiPreferences.js";

/**
 * Provider-visible reasoning, previewed, inline, or behind a "Thought" disclosure.
 * The normalizer surfaces thinking as a message.delta with
 * payload.thinking === true; the turn folder routes those groups here instead
 * of rendering them as inline answer text.
 *
 * Speaks the same disclosure vocabulary as the turn/tool rows — a quiet label
 * and chevron — so reasoning and tool work read as one consistent set of
 * foldable sections within a turn. The violet brain identifies reasoning while
 * the label stays neutral-muted, so it remains subordinate to the actual work
 * and the answer.
 *
 * Preview mode bounds the latest live reasoning and only opens the full body
 * on request. Inline mode keeps the full body and its label visible.
 * In collapsed mode, while the turn hasn't produced its answer yet the
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

/** First line of the reasoning, stripped of Markdown emphasis and markers, so a
 *  folded "Thought" says what it was about. */
function thoughtExcerpt(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  // Paired emphasis and code ticks only: a bare `_` belongs to `session_id`.
  return line
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\*(\S[^*]*)\*/g, "$1")
    .trim();
}

export function ThoughtBlock({
  children,
  previewText,
  display = "collapsed",
  defaultExpanded = false,
  autoExpandWhileLive = true,
  live = false,
  holdOpen = false,
  durationMs
}: {
  children: ReactNode;
  previewText: string;
  display?: ThinkingDisplay;
  defaultExpanded?: boolean;
  /** Compact reasoning stays behind its own disclosure even while live. */
  autoExpandWhileLive?: boolean;
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
  const autoExpanded = display === "preview" || !autoExpandWhileLive
    ? defaultExpanded
    : live || (holdOpen && openedLive) || defaultExpanded;
  const expanded = userToggle?.autoExpanded === autoExpanded ? userToggle.value : autoExpanded;
  const label = formatThoughtLabel(live, durationMs);
  const excerpt = !live && !expanded ? thoughtExcerpt(previewText) : "";
  const titleVerb = live ? "thinking" : "thought";
  // The tail cut is in UTF-16 units and can split a surrogate pair; a tail
  // that starts with a lone low surrogate would render a replacement
  // character at the head of the preview.
  const previewTail = (() => {
    if (previewText.length <= 600) return previewText;
    const tail = previewText.slice(-600);
    return /[\uDC00-\uDFFF]/.test(tail[0] ?? "") ? `…${tail.slice(1)}` : `…${tail}`;
  })();
  // Inline thoughts remain part of the transcript, including when the reader
  // folds tool activity or a newer turn arrives.
  if (display === "inline") {
    return (
      <div className="thought-block" data-live={live ? "true" : undefined} data-display="inline">
        <span className="thought-block-eyebrow">
          <span className="activity-icon-slot">
            <Brain size={14} className="thought-block-icon" aria-hidden="true" />
          </span>
          <span className="thought-block-eyebrow-label">{label}</span>
        </span>
        <div className="thought-block-body">{children}</div>
      </div>
    );
  }
  return (
    <div
      className="thought-block"
      data-live={live ? "true" : undefined}
      data-display={display}
      data-expanded={expanded ? "true" : undefined}
    >
      <button
        type="button"
        className="thought-block-header"
        aria-expanded={expanded}
        aria-label={label}
        title={expanded ? `Hide ${titleVerb}` : `Show full ${titleVerb}`}
        onClick={() => setUserToggle({ value: !expanded, autoExpanded })}
      >
        <span className="thought-block-eyebrow">
          <span className="activity-icon-slot">
            <Brain size={14} className="thought-block-icon" aria-hidden="true" />
          </span>
          <span className="thought-block-eyebrow-label">{label}</span>
        </span>
        {excerpt ? <span className="thought-block-excerpt" aria-hidden="true">{excerpt}</span> : null}
        <ChevronRight
          size={12}
          className={`thought-block-chevron${expanded ? " expanded" : ""}`}
          aria-hidden="true"
        />
      </button>
      {display === "preview" && live && !expanded ? (
        <p className="thought-block-preview" aria-label="Thinking preview">
          {previewTail}
        </p>
      ) : null}
      {expanded ? <div className="thought-block-body">{children}</div> : null}
    </div>
  );
}
