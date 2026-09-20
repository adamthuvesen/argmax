import { Check, Code2, Copy, WrapText } from "lucide-react";
import { Children, useContext, useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import {
  highlightCode,
  plainCodeLines,
  resolveFenceLang,
  useHighlightThemeAppearance,
  useHighlighterReady,
  type HighlightAppearance,
  type HighlightToken
} from "../lib/highlighter.js";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard.js";
import { StreamingCodeContext } from "./streamingCodeContext.js";

const LANGUAGE_CLASS_PREFIX = "language-";

const HIGHLIGHT_DEBOUNCE_MS = 150;

const FENCE_LABELS: Record<string, string> = {
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  javascript: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  py: "Python",
  python: "Python",
  go: "Go",
  golang: "Go",
  rs: "Rust",
  rust: "Rust",
  json: "JSON",
  jsonc: "JSONC",
  md: "Markdown",
  markdown: "Markdown",
  html: "HTML",
  htm: "HTML",
  xml: "XML",
  css: "CSS",
  scss: "SCSS",
  sh: "Shell",
  bash: "Bash",
  zsh: "Zsh",
  shell: "Shell",
  shellscript: "Shell",
  console: "Console",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML"
};

// Non-streaming: highlight synchronously, exactly as before. Streaming: show
// plain text and schedule the highlight; each new keystroke cancels and
// reschedules, so shiki runs once, when the fence settles.
function useCodeHighlight(
  code: string,
  lang: string | null,
  streaming: boolean,
  appearance: HighlightAppearance
): HighlightToken[][] {
  const syncLines = useMemo(
    () => (streaming ? null : highlightCode(code, lang, appearance)),
    [streaming, code, lang, appearance]
  );
  const [deferred, setDeferred] = useState<{
    code: string;
    lang: string | null;
    appearance: HighlightAppearance;
    lines: HighlightToken[][];
  } | null>(null);

  useEffect(() => {
    if (!streaming) return undefined;
    const handle = window.setTimeout(() => {
      setDeferred({ code, lang, appearance, lines: highlightCode(code, lang, appearance) });
    }, HIGHLIGHT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [streaming, code, lang, appearance]);

  if (!streaming) return syncLines as HighlightToken[][];
  if (deferred && deferred.code === code && deferred.lang === lang && deferred.appearance === appearance) {
    return deferred.lines;
  }
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

function formatFenceLabel(fenceTag: string | null): string | null {
  if (!fenceTag || ["text", "plaintext", "plain", "txt"].includes(fenceTag.toLowerCase())) {
    return null;
  }
  const normalized = fenceTag.toLowerCase();
  return (
    FENCE_LABELS[normalized] ??
    fenceTag.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
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
  const [copyFlash, copy] = useCopyToClipboard();
  const ready = useHighlighterReady();
  const appearance = useHighlightThemeAppearance();
  const streaming = useContext(StreamingCodeContext);
  const lang = useMemo(() => (ready ? resolveFenceLang(fenceTag) : null), [ready, fenceTag]);
  const lines = useCodeHighlight(codeText, lang, streaming, appearance);
  const [wrapLines, setWrapLines] = useState(false);

  const handleCopy = (): void => {
    void copy(codeText);
  };

  // "```text" and friends mean "no highlighting", not a language worth
  // naming. Keep the toolbar in flow even for plain fences so it can never
  // cover the first line of a short block.
  const labelTag = formatFenceLabel(fenceTag);
  return (
    <div
      className="code-block"
      data-lang={lang ?? undefined}
      data-label={labelTag ?? undefined}
      data-wrap={wrapLines ? "true" : undefined}
    >
      <div className="code-block-header">
        <div className="code-block-heading">
          <Code2 className="code-block-icon" size={15} strokeWidth={2} aria-hidden="true" />
          {labelTag ? <span className="code-block-lang">{labelTag}</span> : null}
        </div>
        <div className="code-block-actions">
          <button
            type="button"
            className="code-block-action"
            aria-label="Wrap lines"
            aria-pressed={wrapLines}
            title={wrapLines ? "Unwrap lines" : "Wrap lines"}
            onClick={() => setWrapLines((current) => !current)}
          >
            <WrapText size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="code-block-action code-block-copy"
            aria-label="Copy code"
            title={copyFlash === "copied" ? "Copied" : copyFlash === "failed" ? "Couldn't copy" : "Copy code"}
            onClick={handleCopy}
          >
            {copyFlash === "copied" ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          </button>
        </div>
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
      <span className="code-block-status" role="status" aria-live="polite">
        {copyFlash === "copied" ? "Code copied." : copyFlash === "failed" ? "Could not copy code." : ""}
      </span>
    </div>
  );
}
