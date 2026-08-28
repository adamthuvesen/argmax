import { memo, useMemo, useSyncExternalStore, type JSX } from "react";
import { type ParsedDiffBlock } from "../lib/diff.js";
import { highlightLine, langFromPath, useHighlighterReady } from "../lib/highlighter.js";
import { themeAppearance } from "../lib/theme.js";

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
  filePath
}: {
  blocks: ParsedDiffBlock[];
  filePath?: string | null;
}): JSX.Element {
  // Subscribing to the ready signal re-renders the component as soon as the
  // shiki bundle finishes loading, swapping in highlighted tokens without
  // blocking the initial paint.
  const ready = useHighlighterReady();
  useHighlightThemeAppearance();
  const lang = useMemo(() => langFromPath(filePath ?? null), [filePath]);
  const effectiveLang = ready ? lang : null;
  return (
    <div className="diff-blocks">
      {blocks.map((block) =>
        block.kind === "omitted" ? null : (
          <UnifiedHunk key={block.id} block={block} lang={effectiveLang} />
        )
      )}
    </div>
  );
});

function UnifiedHunk({
  block,
  lang
}: {
  block: Extract<ParsedDiffBlock, { kind: "hunk" }>;
  lang: string | null;
}): JSX.Element {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">{block.header}</div>
      {block.lines.map((line, index) => (
        <div className={`diff-line ${line.kind}`} key={`${block.id}-${index}`}>
          <span className="diff-line-number">
            {line.newLineNumber ?? line.oldLineNumber ?? ""}
          </span>
          <code>
            <DiffLineContent content={line.content || " "} lang={lang} />
          </code>
        </div>
      ))}
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
