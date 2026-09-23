import { Check, Code2, Copy, WrapText } from "lucide-react";
import { Children, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from "react";
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

const LIVE_HIGHLIGHT_INTERVAL_MS = 150;

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
/** Past this many lines a fence still being written stays plain until it
    closes: re-tokenizing it on every throttle tick would cost frames. */
const LIVE_HIGHLIGHT_MAX_LINES = 400;

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
  const latest = useRef({ code, lang, appearance });
  latest.current = { code, lang, appearance };
  const pending = useRef<number | null>(null);

  // A throttle, not a debounce: a reveal that grows the fence every frame
  // would otherwise keep pushing the highlight back until the fence closed.
  useEffect(() => {
    if (!streaming || pending.current !== null) return;
    pending.current = window.setTimeout(() => {
      pending.current = null;
      const current = latest.current;
      if (current.code.split("\n", LIVE_HIGHLIGHT_MAX_LINES + 1).length > LIVE_HIGHLIGHT_MAX_LINES) return;
      setDeferred({ ...current, lines: highlightCode(current.code, current.lang, current.appearance) });
    }, LIVE_HIGHLIGHT_INTERVAL_MS);
  }, [streaming, code, lang, appearance]);
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    []
  );

  if (!streaming) return syncLines as HighlightToken[][];
  if (!deferred || deferred.lang !== lang || deferred.appearance !== appearance) {
    return plainCodeLines(code);
  }
  if (deferred.code === code) return deferred.lines;
  if (!code.startsWith(deferred.code)) return plainCodeLines(code);
  // The lines highlighted last time keep their colors; the line that was
  // still being written and everything after it stay plain until the next pass.
  const settled = deferred.lines.length - 1;
  const settledLength = deferred.code.lastIndexOf("\n") + 1;
  return [...deferred.lines.slice(0, settled), ...plainCodeLines(code.slice(settledLength))];
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
