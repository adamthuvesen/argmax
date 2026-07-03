import { Check, Copy } from "lucide-react";
import { Children, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import {
  highlightCode,
  plainCodeLines,
  resolveFenceLang,
  useHighlighterReady,
  type HighlightToken
} from "../lib/highlighter.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";

const LANGUAGE_CLASS_PREFIX = "language-";

const HIGHLIGHT_DEBOUNCE_MS = 150;

// Non-streaming: highlight synchronously, exactly as before. Streaming: show
// plain text and schedule the highlight; each new keystroke cancels and
// reschedules, so shiki runs once, when the fence settles.
function useCodeHighlight(code: string, lang: string | null, streaming: boolean): HighlightToken[][] {
  const syncLines = useMemo(
    () => (streaming ? null : highlightCode(code, lang)),
    [streaming, code, lang]
  );
  const [deferred, setDeferred] = useState<{
    code: string;
    lang: string | null;
    lines: HighlightToken[][];
  } | null>(null);

  useEffect(() => {
    if (!streaming) return undefined;
    const handle = window.setTimeout(() => {
      setDeferred({ code, lang, lines: highlightCode(code, lang) });
    }, HIGHLIGHT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [streaming, code, lang]);

  if (!streaming) return syncLines as HighlightToken[][];
  if (deferred && deferred.code === code && deferred.lang === lang) return deferred.lines;
  return plainCodeLines(code);
}

function extractFenceTag(className: string | undefined): string | null {
  if (!className) return null;
  const tokens = className.split(/\s+/);
  for (const token of tokens) {
    if (token.startsWith(LANGUAGE_CLASS_PREFIX)) {
      const lang = token.slice(LANGUAGE_CLASS_PREFIX.length).trim();
      return lang || null;
    }
  }
  return null;
}

function collectText(children: ReactNode): string {
  let out = "";
  Children.forEach(children, (child) => {
    if (child == null || child === false) return;
    if (typeof child === "string" || typeof child === "number") {
      out += String(child);
      return;
    }
    if (Array.isArray(child)) {
      out += collectText(child);
      return;
    }
    if (typeof child === "object" && "props" in child) {
      const innerChildren = (child as { props: { children?: ReactNode } }).props.children;
      if (innerChildren !== undefined) {
        out += collectText(innerChildren);
      }
    }
  });
  return out;
}

export function CodeBlock({
  className,
  children
}: {
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const fenceTag = useMemo(() => extractFenceTag(className), [className]);
  const codeText = useMemo(() => collectText(children).replace(/\n$/, ""), [children]);
  const [copied, copy] = useCopyToClipboard();
  const ready = useHighlighterReady();
  const streaming = useContext(StreamingCodeContext);
  const lang = useMemo(() => (ready ? resolveFenceLang(fenceTag) : null), [ready, fenceTag]);
  const lines = useCodeHighlight(codeText, lang, streaming);

  const handleCopy = (): void => {
    void copy(codeText);
  };

  const labelTag = fenceTag ?? null;
  return (
    <div className="code-block" data-lang={lang ?? undefined}>
      <div className="code-block-header">
        {labelTag ? (
          <span className="code-block-lang">{labelTag}</span>
        ) : (
          <span className="code-block-lang code-block-lang--blank" aria-hidden="true" />
        )}
        <button
          type="button"
          className="code-block-copy"
          aria-label="Copy code"
          title={copied ? "Copied!" : "Copy code"}
          onClick={handleCopy}
        >
          {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
        </button>
      </div>
      <pre className={className ?? ""}>
        <code className={className ?? ""}>
          {lines.map((line, index) => (
            <span className="code-block-line" key={index}>
              {line.length === 0 ? (
                "\n"
              ) : (
                <>
                  {line.map((token, tIndex) => (
                    <span
                      className="hl-token"
                      key={tIndex}
                      style={token.color ? { color: token.color } : undefined}
                    >
                      {token.content}
                    </span>
                  ))}
                  {index < lines.length - 1 ? "\n" : null}
                </>
              )}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
