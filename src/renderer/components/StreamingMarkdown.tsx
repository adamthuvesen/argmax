import { useEffect, useMemo, useRef, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceSummary } from "../../shared/types.js";
import { matchFileChip } from "../lib/fileChipPath.js";
import { CodeBlock } from "./CodeBlock.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";

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

  return (
    <div className={`markdown${streaming ? " markdown-streaming" : ""}`}>
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
        {visibleText}
      </ReactMarkdown>
    </div>
  );
}
