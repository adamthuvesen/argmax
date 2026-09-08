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
import { ChevronsUpDown, Plus } from "lucide-react";
import { type ParsedDiffBlock } from "../lib/diff.js";
import { highlightLine, langFromPath, useHighlighterReady } from "../lib/highlighter.js";
import { themeAppearance } from "../lib/theme.js";
import type { DiffNoteAnchor } from "../lib/composerAnnotations.js";

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

type DiffHunk = Extract<ParsedDiffBlock, { kind: "hunk" }>;

interface CommentSelection {
  block: DiffHunk;
  filePath: string;
  anchor: number;
  focus: number;
  dragging: boolean;
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
  onAddComment,
  onExpandContext
}: {
  blocks: ParsedDiffBlock[];
  filePath?: string | null;
  /** When provided (the review panel), every numbered diff line grows a
   *  hover "+" that opens an inline comment form. Submitted comments land on
   *  the session composer as diff notes. */
  onAddComment?: (input: DiffNoteAnchor) => void;
  /** When provided, each between-hunk gap becomes a button that asks for more
   *  context. Omit it (chat cards) and the gaps render as static labels. */
  onExpandContext?: () => void;
}): JSX.Element {
  // Subscribing to the ready signal re-renders the component as soon as the
  // shiki bundle finishes loading, swapping in highlighted tokens without
  // blocking the initial paint.
  const ready = useHighlighterReady();
  const appearance = useHighlightThemeAppearance();
  const lang = useMemo(() => langFromPath(filePath ?? null), [filePath]);
  const effectiveLang = ready ? lang : null;
  const [selection, setSelection] = useState<CommentSelection | null>(null);
  // A refreshed diff can reuse hunk ids and line numbers for different code.
  const activeSelection = selection && selection.filePath === filePath && blocks.includes(selection.block)
    ? selection
    : null;
  const dragging = activeSelection?.dragging === true;
  useEffect(() => {
    if (!dragging) return;
    const finish = (): void => {
      setSelection((current) => current ? { ...current, dragging: false } : null);
    };
    const cancel = (): void => setSelection(null);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dragging]);
  // A truncated diff already dropped content, so asking git for more context
  // would only drop more. Show the gaps, but stop advertising the action.
  const truncated = blocks.some((block) => block.kind === "truncated");
  return (
    <div className="diff-blocks" data-selecting={dragging || undefined}>
      {blocks.map((block) => {
        switch (block.kind) {
          case "hunk":
            return (
              <UnifiedHunk
                key={block.id}
                block={block}
                lang={effectiveLang}
                appearance={appearance}
                filePath={filePath ?? null}
                onAddComment={onAddComment}
                selection={activeSelection?.block === block ? activeSelection : null}
                onSelectionChange={setSelection}
              />
            );
          case "omitted":
            return (
              <OmittedLines
                key={block.id}
                count={block.count}
                onExpand={truncated ? undefined : onExpandContext}
              />
            );
          case "truncated":
            return (
              <p key={block.id} className="diff-truncated" role="status">
                Diff too large to show in full — {formatBytes(block.droppedBytes)} of changes
                were dropped. Open the file to see the rest.
              </p>
            );
          default: {
            const exhaustive: never = block;
            return exhaustive;
          }
        }
      })}
    </div>
  );
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The unchanged lines git left out between two hunks. Clicking asks for more
 * context for the whole file, so every gap in the file opens at once — after
 * the reload each remaining band reports its new, smaller count, and bands
 * whose gap closed disappear.
 */
function OmittedLines({
  count,
  onExpand
}: {
  count: number;
  onExpand?: () => void;
}): JSX.Element {
  const label = `${count} unmodified ${count === 1 ? "line" : "lines"}`;
  if (!onExpand) {
    return <div className="diff-omitted">{label}</div>;
  }
  return (
    <button
      type="button"
      className="diff-omitted diff-omitted-expand"
      aria-label={`Expand ${label}`}
      title="Show more unchanged context"
      onClick={onExpand}
    >
      <ChevronsUpDown size={12} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

function UnifiedHunk({
  block,
  lang,
  appearance,
  filePath,
  onAddComment,
  selection,
  onSelectionChange
}: {
  block: DiffHunk;
  lang: string | null;
  appearance: "light" | "dark";
  filePath: string | null;
  onAddComment?: (input: DiffNoteAnchor) => void;
  selection: CommentSelection | null;
  onSelectionChange: (selection: CommentSelection | null) => void;
}): JSX.Element {
  const start = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const end = selection ? Math.max(selection.anchor, selection.focus) : -1;
  const selectedLines = selection ? block.lines.slice(start, end + 1) : [];
  const firstLine = selectedLines[0];
  const lastLine = selectedLines.at(-1);
  const startLine = firstLine?.newLineNumber ?? firstLine?.oldLineNumber;
  const endLine = lastLine?.newLineNumber ?? lastLine?.oldLineNumber;
  const range = start !== end;
  const crossesSides = firstLine && lastLine
    && (firstLine.kind === "deletion") !== (lastLine.kind === "deletion");
  const location = crossesSides
    ? `${filePath}:${startLine} (${firstLine.kind === "deletion" ? "removed" : firstLine.kind === "addition" ? "added" : "unchanged"})-${endLine} (${lastLine.kind === "deletion" ? "removed" : lastLine.kind === "addition" ? "added" : "unchanged"})`
    : `${filePath}:${startLine}${range ? `-${endLine}` : ""}`;
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{block.header}</div>
      {block.lines.map((line, index) => {
        const key = `${block.id}-${index}`;
        const lineNumber = line.newLineNumber ?? line.oldLineNumber ?? null;
        const commentable = onAddComment !== undefined && filePath !== null && lineNumber !== null;
        return (
          <div key={key}>
            <div
              className={`diff-line ${line.kind}`}
              data-selected={index >= start && index <= end || undefined}
              onMouseEnter={() => {
                if (selection?.dragging && lineNumber !== null) {
                  onSelectionChange({ ...selection, focus: index });
                }
              }}
            >
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
                    aria-pressed={index >= start && index <= end}
                    title="Click to comment, or drag to select multiple lines"
                    onMouseDown={(event) => {
                      if (event.button !== 0) return;
                      event.preventDefault();
                      onSelectionChange({ block, filePath, anchor: index, focus: index, dragging: true });
                    }}
                    onClick={(event) => {
                      // Mouse selection finishes on mouseup. Its following
                      // click must not collapse the range back to one line.
                      if (event.detail !== 0) return;
                      onSelectionChange(selection && start === index && end === index
                        ? null
                        : { block, filePath, anchor: index, focus: index, dragging: false });
                    }}
                  >
                    <Plus size={12} aria-hidden="true" />
                  </button>
                ) : null}
              </span>
              <code>
                <DiffLineContent content={line.content || " "} lang={lang} appearance={appearance} />
              </code>
            </div>
            {commentable && selection && !selection.dragging && index === end && firstLine && lastLine ? (
              <DiffCommentForm
                key={`${start}-${end}`}
                location={location}
                onCancel={() => onSelectionChange(null)}
                onSubmit={(comment) => {
                  onAddComment({
                    filePath,
                    line: startLine ?? null,
                    ...(range ? { endLine: endLine ?? undefined, endSide: lastLine.kind } : {}),
                    // A deletion's number is the pre-change one, so the side
                    // travels with it: the agent needs to know that line is
                    // not in the file on disk.
                    side: firstLine.kind,
                    lineText: selectedLines.map((selected) => {
                      if (!range) return selected.content;
                      const prefix = selected.kind === "addition" ? "+" : selected.kind === "deletion" ? "-" : " ";
                      return `${prefix}${selected.content}`;
                    }).join("\n"),
                    comment
                  });
                  onSelectionChange(null);
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

// Selection changes must not tokenize unchanged code again. Appearance stays
// in the memo's props because the highlighter reads the theme from the DOM.
const DiffLineContent = memo(function DiffLineContent({ content, lang }: {
  content: string;
  lang: string | null;
  appearance: "light" | "dark";
}): JSX.Element {
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
});
