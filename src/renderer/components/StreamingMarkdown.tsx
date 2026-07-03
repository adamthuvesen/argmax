import { memo, useEffect, useMemo, useRef, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceSummary } from "../../shared/types.js";
import { matchFileChip } from "../lib/fileChipPath.js";
import { CodeBlock } from "./CodeBlock.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";

const SMOOTH_STREAM_TICK_MS = 32;
const SMOOTH_STREAM_CHARS_PER_TICK = 5;
const SMOOTH_STREAM_MIN_CHARS = 80;

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

function initialVisibleLength(text: string, streaming: boolean): number {
  const length = Array.from(text).length;
  return streaming && length > SMOOTH_STREAM_MIN_CHARS ? 0 : length;
}

function useSmoothStreamingText(text: string, streaming: boolean): string {
  const prefersReducedMotion = usePrefersReducedMotion();
  const textCharacters = useMemo(() => Array.from(text), [text]);
  const targetLength = textCharacters.length;
  const targetLengthRef = useRef(targetLength);
  const [visibleLength, setVisibleLength] = useState(() => initialVisibleLength(text, streaming));

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
  let idx = text.lastIndexOf("\n\n");
  while (idx >= 0) {
    const head = text.slice(0, idx + 2);
    const fences = head.match(/^```/gm);
    if (!fences || fences.length % 2 === 0) {
      return { committed: head, tail: text.slice(idx + 2) };
    }
    idx = text.lastIndexOf("\n\n", idx - 1);
  }
  return { committed: "", tail: text };
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
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: ({ className, children, ...rest }) => {
          const hasLanguage = typeof className === "string" && className.includes("language-");
          const codeText = Array.isArray(children)
            ? children.map((c) => (typeof c === "string" ? c : "")).join("")
            : typeof children === "string"
              ? children
              : "";
          if (hasLanguage || codeText.includes("\n")) {
            return <CodeBlock className={className}>{children}</CodeBlock>;
          }
          const match = matchFileChip(codeText);
          if (match) {
            return (
              <FileChip
                path={match.path}
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
          if (/^(?:https?:|mailto:)/.test(href)) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
                {children}
              </a>
            );
          }
          const match = matchFileChip(href);
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
        pre: ({ children }) => <>{children}</>
      }}
    >
      {text}
    </ReactMarkdown>
  );
});

export function StreamingMarkdown({
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
  const visibleText = useSmoothStreamingText(text, streaming);
  // Only split while actively revealing. A completed message (or reduced-motion)
  // renders as a single root — byte-identical to the non-streaming path.
  const split = useMemo(
    () => (streaming ? splitStreamingMarkdown(visibleText) : null),
    [streaming, visibleText]
  );

  return (
    <div className={`markdown${streaming ? " markdown-streaming" : ""}`}>
      <StreamingCodeContext.Provider value={streaming}>
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
          <MarkdownBody text={visibleText} workspace={workspace} onOpenFile={onOpenFile} />
        )}
      </StreamingCodeContext.Provider>
    </div>
  );
}
