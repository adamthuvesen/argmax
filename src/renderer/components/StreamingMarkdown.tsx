import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type JSX } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { WorkspaceSummary } from "../../shared/types.js";
import { matchFileChip, normalizeFileChipPath } from "../lib/fileChipPath.js";
import { splitLogSegments } from "../lib/logDump.js";
import { isMermaidFenceClass } from "../lib/mermaidFence.js";
import { normalizeMathDelimiters } from "../lib/normalizeMathDelimiters.js";
import { CodeBlock } from "./CodeBlock.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";
import { LogBlock } from "./LogBlock.js";
import { MarkdownTable } from "./MarkdownTable.js";
import { MarkdownImage } from "./MarkdownImage.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";
import { WebLink } from "./WebLink.js";

const MermaidDiagram = lazy(async () => ({
  default: (await import("./MermaidDiagram.js")).MermaidDiagram
}));

const SMOOTH_STREAM_TICK_MS = 32;
const SMOOTH_STREAM_CHARS_PER_TICK = 5;
const SMOOTH_STREAM_MIN_CHARS = 80;
/** Blocks to remember reveal progress for. Bounded so a long-running app can't
    accumulate an entry per streamed block for the rest of the process. */
const MAX_REMEMBERED_BLOCKS = 200;

function chatUrlTransform(value: string): string {
  if (/^argmax-(?:asset|attachment):\/\//i.test(value)) return value;
  return defaultUrlTransform(value);
}

/**
 * How much of each block the reader has already watched appear, kept outside
 * React because the component doesn't survive what it has to survive: switching
 * sessions remounts the whole pane, and a live block would otherwise type
 * itself out again from nothing every time the user came back to it.
 */
const revealedLengths = new Map<string, number>();

function rememberRevealed(key: string, length: number): void {
  // Re-insert so the map stays in least-recently-revealed order for trimming.
  revealedLengths.delete(key);
  revealedLengths.set(key, length);
  if (revealedLengths.size > MAX_REMEMBERED_BLOCKS) {
    const oldest = revealedLengths.keys().next();
    if (!oldest.done) revealedLengths.delete(oldest.value);
  }
}

function readPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(readPrefersReducedMotion);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handleChange = (): void => setPrefersReducedMotion(media.matches);
    handleChange();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  return prefersReducedMotion;
}

function initialVisibleLength(
  text: string,
  streaming: boolean,
  revealKey: string | null | undefined
): number {
  const length = Array.from(text).length;
  if (!streaming || length <= SMOOTH_STREAM_MIN_CHARS) return length;
  // Text already revealed once is history, so resume there instead of retyping it.
  const revealed = revealKey ? revealedLengths.get(revealKey) : undefined;
  return revealed === undefined ? 0 : Math.min(revealed, length);
}

function useSmoothStreamingText(
  text: string,
  streaming: boolean,
  revealKey: string | null | undefined
): string {
  const prefersReducedMotion = usePrefersReducedMotion();
  const textCharacters = useMemo(() => Array.from(text), [text]);
  const targetLength = textCharacters.length;
  const targetLengthRef = useRef(targetLength);
  const [visibleLength, setVisibleLength] = useState(() =>
    initialVisibleLength(text, streaming, revealKey)
  );

  useEffect(() => {
    if (revealKey && streaming) rememberRevealed(revealKey, visibleLength);
  }, [revealKey, streaming, visibleLength]);

  useEffect(() => {
    targetLengthRef.current = targetLength;
    if (!streaming || prefersReducedMotion) {
      setVisibleLength(targetLength);
      return;
    }
    setVisibleLength((current) => {
      if (targetLength <= SMOOTH_STREAM_MIN_CHARS && current === 0) {
        return targetLength;
      }
      return Math.min(current, targetLength);
    });
  }, [prefersReducedMotion, streaming, targetLength]);

  useEffect(() => {
    if (!streaming || prefersReducedMotion) {
      return;
    }
    const interval = window.setInterval(() => {
      setVisibleLength((current) => {
        const target = targetLengthRef.current;
        if (current >= target) {
          return current;
        }
        return Math.min(current + SMOOTH_STREAM_CHARS_PER_TICK, target);
      });
    }, SMOOTH_STREAM_TICK_MS);
    return () => window.clearInterval(interval);
  }, [prefersReducedMotion, streaming]);

  if (!streaming || prefersReducedMotion || visibleLength >= targetLength) {
    return text;
  }
  return textCharacters.slice(0, visibleLength).join("");
}

// Split the revealed text into a stable "committed" prefix (whole, completed
// blocks) and the block currently being typed. Splitting only at blank-line
// boundaries whose prefix has balanced code fences keeps each half independently
// valid markdown, so the committed prefix re-parses once per completed block
// instead of once per typewriter frame. react-markdown adds no wrapper element,
// so the two halves render as flat sibling blocks with normal margin collapse.
function splitStreamingMarkdown(text: string): { committed: string; tail: string } {
  // One forward pass. Walking back from the end instead re-counted the fences
  // over the whole prefix per candidate boundary, and an open fence — the state
  // an agent is in for as long as it is emitting a code block — rejects every
  // boundary inside it, so the cost grew with the square of the block.
  let insideFence = false;
  let insideMath = false;
  let cut = -1;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i !== text.length && text.charCodeAt(i) !== 10) continue;
    const line = text.slice(lineStart, i).trim();
    if (i === lineStart) {
      // A blank line: the second "\n" of a paragraph break. End of text is not
      // one, only an unterminated last line, so it can never commit the tail.
      if (i !== text.length && lineStart > 0 && !insideFence && !insideMath) cut = lineStart + 1;
    } else if (line.startsWith("```") || line.startsWith("~~~")) {
      insideFence = !insideFence;
    } else if (line.startsWith("$$") || line.startsWith("\\[")) {
      if (line.length > 2 && (line.endsWith("$$") || line.endsWith("\\]"))) {
        // Opened and closed on the same line
      } else {
        insideMath = !insideMath;
      }
    } else if (insideMath && (line.endsWith("$$") || line.endsWith("\\]"))) {
      insideMath = false;
    }
    lineStart = i + 1;
  }
  return cut < 0
    ? { committed: "", tail: text }
    : { committed: text.slice(0, cut), tail: text.slice(cut) };
}

function MermaidDiagramFallback(): JSX.Element {
  return (
    <figure className="mermaid-diagram" data-state="pending" aria-label="Diagram">
      <p className="mermaid-diagram-pending" role="status">
        Drawing diagram
      </p>
    </figure>
  );
}

// One markdown render root. Memoized on its props so a stable `text` (the
// committed prefix, which only changes when a block completes) skips re-parsing
// entirely — `workspace` and `onOpenFile` are stable from the session pane.
const MarkdownBody = memo(function MarkdownBody({
  text,
  workspace,
  onOpenFile
}: {
  text: string;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element {
  const normalizedText = useMemo(() => normalizeMathDelimiters(text), [text]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      urlTransform={chatUrlTransform}
      components={{
        code: ({ className, children, ...rest }) => {
          const hasLanguage = typeof className === "string" && className.includes("language-");
          const codeText = Array.isArray(children)
            ? children.map((c) => (typeof c === "string" ? c : "")).join("")
            : typeof children === "string"
              ? children
              : "";
          if (isMermaidFenceClass(className)) {
            return (
              <Suspense fallback={<MermaidDiagramFallback />}>
                <MermaidDiagram source={codeText.replace(/\n$/, "")} />
              </Suspense>
            );
          }
          if (hasLanguage || codeText.includes("\n")) {
            return <CodeBlock className={className}>{children}</CodeBlock>;
          }
          const match = matchFileChip(codeText);
          if (match) {
            const path = normalizeFileChipPath(match.path, workspace?.path);
            return (
              <FileChip
                path={path}
                line={match.line}
                workspaceId={workspace?.id ?? null}
                workspaceCwd={workspace?.path ?? null}
                onOpen={onOpenFile}
              />
            );
          }
          return (
            <code className={className} {...rest}>
              {children}
            </code>
          );
        },
        a: ({ href, children, ...rest }) => {
          if (!href || href.startsWith("#")) {
            return (
              <a href={href} {...rest}>
                {children}
              </a>
            );
          }
          if (/^https?:/.test(href)) {
            return (
              <WebLink href={href} {...rest}>
                {children}
              </WebLink>
            );
          }
          if (/^mailto:/.test(href)) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                {children}
              </a>
            );
          }
          const normalizedHref = normalizeFileChipPath(href, workspace?.path);
          const match = matchFileChip(normalizedHref);
          if (!match) {
            return (
              <a href={href} {...rest}>
                {children}
              </a>
            );
          }
          return (
            <FileChip
              path={match.path}
              line={match.line}
              workspaceId={workspace?.id ?? null}
              workspaceCwd={workspace?.path ?? null}
              onOpen={onOpenFile}
            />
          );
        },
        img: ({ src, alt }) => (
          <MarkdownImage
            src={src}
            alt={alt}
            workspace={workspace}
            onOpenFile={onOpenFile}
          />
        ),
        table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
        pre: ({ children }) => <>{children}</>
      }}
    >
      {normalizedText}
    </ReactMarkdown>
  );
});

function MarkdownStream({
  text,
  streaming,
  workspace,
  onOpenFile
}: {
  text: string;
  streaming: boolean;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element {
  // Only split while actively revealing. A completed message (or reduced-motion)
  // renders as a single root — byte-identical to the non-streaming path.
  const split = useMemo(
    () => (streaming ? splitStreamingMarkdown(text) : null),
    [streaming, text]
  );
  return (
    <>
      {split ? (
        <>
          {split.committed ? (
            <MarkdownBody text={split.committed} workspace={workspace} onOpenFile={onOpenFile} />
          ) : null}
          {split.tail ? (
            <MarkdownBody text={split.tail} workspace={workspace} onOpenFile={onOpenFile} />
          ) : null}
        </>
      ) : (
        <MarkdownBody text={text} workspace={workspace} onOpenFile={onOpenFile} />
      )}
    </>
  );
}

export function StreamingMarkdown({
  text,
  streaming,
  paced = true,
  revealKey,
  workspace,
  onOpenFile
}: {
  text: string;
  streaming: boolean;
  /** Reveal a streaming block at the typewriter cadence. Off, the block shows
      every character as it arrives but still keeps the committed/tail split,
      so a fast reasoning burst neither lags behind nor re-parses in full. */
  paced?: boolean;
  /** Stable identity for this block of text, unique across sessions and turns.
      Without one, a streaming block restarts its reveal on every remount. */
  revealKey?: string | null;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element | null {
  const visibleText = useSmoothStreamingText(text, streaming && paced, revealKey);
  const segments = useMemo(() => splitLogSegments(visibleText), [visibleText]);
  if (segments.length === 0 && visibleText.length > 0) return null;
  const hasLogs = segments.some((segment) => segment.kind === "log");
  const markdownText = hasLogs ? visibleText : segments.map((segment) => segment.text).join("");

  return (
    <div
      className={
        hasLogs
          ? `markdown-with-logs${streaming ? " markdown-streaming" : ""}`
          : `markdown${streaming ? " markdown-streaming" : ""}`
      }
    >
      <StreamingCodeContext.Provider value={streaming}>
        {hasLogs
          ? segments.map((segment, index) =>
              segment.kind === "log" ? (
                <LogBlock key={`log-${index}`} text={segment.text} />
              ) : (
                <div key={`md-${index}`} className="markdown">
                  <MarkdownBody text={segment.text} workspace={workspace} onOpenFile={onOpenFile} />
                </div>
              )
            )
          : (
            <MarkdownStream
              text={markdownText}
              streaming={streaming}
              workspace={workspace}
              onOpenFile={onOpenFile}
            />
          )}
      </StreamingCodeContext.Provider>
    </div>
  );
}
