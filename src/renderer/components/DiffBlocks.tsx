import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import { Plus } from "lucide-react";
import { type ParsedDiffBlock } from "../lib/diff.js";
import { highlightLine, langFromPath, useHighlighterReady } from "../lib/highlighter.js";
import { themeAppearance } from "../lib/theme.js";
import type { ReviewCommentInput } from "../lib/composerAnnotations.js";

function subscribeToThemeAttribute(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"]
  });
  return () => observer.disconnect();
}

function readThemeAppearance(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return themeAppearance(document.documentElement.getAttribute("data-theme"));
}

/**
 * `highlightLine` resolves the shiki theme from the live `data-theme`
 * attribute, not from props, so the memo below would otherwise freeze token
 * colors across a theme switch. Subscribing makes the appearance part of this
 * component's render identity: a flip re-renders past the memo and re-tokenizes.
 */
function useHighlightThemeAppearance(): "light" | "dark" {
  return useSyncExternalStore(subscribeToThemeAttribute, readThemeAppearance, () => "light");
}

/**
 * Memoized: every `dashboard:delta` re-renders the review panel with a fresh
 * events array, and each render re-runs shiki's tokenizer over every diff line
 * (tens of ms synchronously for a large file). Props are stable at both call
 * sites — `ReviewPanel` memoizes `diffBlocks`, `FileChangeCard` memoizes
 * `change.hunks` — so the memo blocks the per-delta storm while the two real
 * invalidation signals (highlighter readiness, theme) stay component state.
 */
export const DiffBlocks = memo(function DiffBlocks({
  blocks,
  filePath,
  onAddComment
}: {
  blocks: ParsedDiffBlock[];
  filePath?: string | null;
  /** When provided (the review panel), every numbered diff line grows a
   *  hover "+" that opens an inline comment form. Submitted comments land on
   *  the session composer as annotations. */
  onAddComment?: (input: ReviewCommentInput) => void;
}): JSX.Element {
  // Subscribing to the ready signal re-renders the component as soon as the
  // shiki bundle finishes loading, swapping in highlighted tokens without
  // blocking the initial paint.
  const ready = useHighlighterReady();
  useHighlightThemeAppearance();
  const lang = useMemo(() => langFromPath(filePath ?? null), [filePath]);
  const effectiveLang = ready ? lang : null;
  // One open comment form across all hunks, keyed `${block.id}-${index}`.
  const [activeCommentKey, setActiveCommentKey] = useState<string | null>(null);
  return (
    <div className="diff-blocks">
      {blocks.map((block) =>
        block.kind === "omitted" ? null : (
          <UnifiedHunk
            key={block.id}
            block={block}
            lang={effectiveLang}
            filePath={filePath ?? null}
            onAddComment={onAddComment}
            activeCommentKey={activeCommentKey}
            onActiveCommentKeyChange={setActiveCommentKey}
          />
        )
      )}
    </div>
  );
});

function UnifiedHunk({
  block,
  lang,
  filePath,
  onAddComment,
  activeCommentKey,
  onActiveCommentKeyChange
}: {
  block: Extract<ParsedDiffBlock, { kind: "hunk" }>;
  lang: string | null;
  filePath: string | null;
  onAddComment?: (input: ReviewCommentInput) => void;
  activeCommentKey: string | null;
  onActiveCommentKeyChange: (key: string | null) => void;
}): JSX.Element {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{block.header}</div>
      {block.lines.map((line, index) => {
        const key = `${block.id}-${index}`;
        const lineNumber = line.newLineNumber ?? line.oldLineNumber ?? null;
        const commentable = onAddComment !== undefined && filePath !== null && lineNumber !== null;
        return (
          <div key={key}>
            <div className={`diff-line ${line.kind}`}>
              <span className="diff-line-number">
                {lineNumber ?? ""}
                {commentable ? (
                  <button
                    type="button"
                    className="diff-comment-add"
                    // Hover-only affordance, like the Codex gutter. One tab
                    // stop per diff line would bury everything after the panel.
                    tabIndex={-1}
                    aria-label={`Comment on line ${lineNumber} of ${filePath}`}
                    title="Add a comment for this line"
                    onClick={() => onActiveCommentKeyChange(activeCommentKey === key ? null : key)}
                  >
                    <Plus size={12} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
              <code>
                <DiffLineContent content={line.content || " "} lang={lang} />
              </code>
            </div>
            {commentable && activeCommentKey === key ? (
              <DiffCommentForm
                location={`${filePath}:${lineNumber}`}
                onCancel={() => onActiveCommentKeyChange(null)}
                onSubmit={(comment) => {
                  onAddComment({
                    filePath,
                    line: lineNumber,
                    lineText: line.content,
                    comment
                  });
                  onActiveCommentKeyChange(null);
                }}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function DiffCommentForm({
  location,
  onCancel,
  onSubmit
}: {
  location: string;
  onCancel: () => void;
  onSubmit: (comment: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const submit = (): void => {
    const comment = draft.trim();
    if (!comment) return;
    onSubmit(comment);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="diff-comment-form" role="form" aria-label={`Comment on ${location}`}>
      <span className="diff-comment-form-location">{location}</span>
      <textarea
        ref={inputRef}
        aria-label="Comment text"
        placeholder="Request a change or leave a note"
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="diff-comment-form-actions">
        <button type="button" className="diff-comment-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="diff-comment-submit"
          disabled={!draft.trim()}
          onClick={submit}
        >
          Comment
        </button>
      </div>
    </div>
  );
}

function DiffLineContent({ content, lang }: { content: string; lang: string | null }): JSX.Element {
  if (!lang) {
    return <>{content}</>;
  }
  const tokens = highlightLine(content, lang);
  if (tokens.length === 1 && tokens[0] && !tokens[0].color) {
    // Shiki returned a single uncolored token — equivalent to the plain
    // fallback. Skip the span wrapper noise.
    return <>{tokens[0].content}</>;
  }
  return (
    <>
      {tokens.map((token, index) => (
        <span
          className="hl-token"
          key={index}
          style={token.color ? { color: token.color } : undefined}
        >
          {token.content}
        </span>
      ))}
    </>
  );
}
