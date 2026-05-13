import { Code, Eye } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import { highlightLine, langFromPath, useHighlighterReady } from "../lib/highlighter.js";

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isMarkdownPath(path: string | null): boolean {
  if (!path) return false;
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown";
}

export function FilePreview({ state }: { state: WorkspaceFilesState }): JSX.Element {
  const ready = useHighlighterReady();
  const lang = useMemo(
    () => (ready ? langFromPath(state.selectedPath) : null),
    [ready, state.selectedPath]
  );
  const markdown = isMarkdownPath(state.selectedPath);
  // Per-file render mode. Default to rendered for markdown; non-markdown
  // files only ever show source so the state is inert there.
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  useEffect(() => {
    setMode("rendered");
  }, [state.selectedPath]);

  if (!state.selectedPath) {
    return <p className="review-empty">Select a file to preview.</p>;
  }
  if (state.previewState === "loading") {
    return <p className="review-empty">Loading file…</p>;
  }
  if (state.previewState === "error") {
    return <p className="review-empty review-error">{state.previewError}</p>;
  }
  const preview = state.preview;
  if (!preview) {
    return <p className="review-empty">No preview available.</p>;
  }
  if (preview.kind === "skipped") {
    const message =
      preview.reason === "binary"
        ? `Binary file${preview.size !== undefined ? ` (${formatBytes(preview.size)})` : ""} — not previewable.`
        : preview.reason === "too-large"
          ? `File too large to preview${preview.size !== undefined ? ` (${formatBytes(preview.size)})` : ""}.`
          : "Not a regular file.";
    return <p className="review-empty">{message}</p>;
  }

  const showRendered = markdown && mode === "rendered";

  return (
    <div className="file-preview" aria-label={`Preview of ${state.selectedPath}`}>
      <div className="file-preview-heading">
        <strong>{state.selectedPath}</strong>
        <div className="file-preview-heading-meta">
          <span className="file-preview-size">{formatBytes(preview.size)}</span>
          {markdown ? (
            <button
              type="button"
              className="small-icon"
              aria-pressed={mode === "source"}
              aria-label={showRendered ? "View markdown source" : "Render markdown preview"}
              title={showRendered ? "View markdown source" : "Render markdown preview"}
              onClick={() => setMode((m) => (m === "rendered" ? "source" : "rendered"))}
            >
              {showRendered ? <Code size={14} /> : <Eye size={14} />}
            </button>
          ) : null}
        </div>
      </div>
      {showRendered ? (
        <div className="file-preview-markdown markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown>
        </div>
      ) : (
        <SourceView content={preview.content} lang={lang} />
      )}
    </div>
  );
}

function SourceView({ content, lang }: { content: string; lang: string | null }): JSX.Element {
  const lines = content.split("\n");
  return (
    <pre className="file-preview-body">
      <code>
        {lines.map((line, index) => (
          <span className="file-preview-line" key={index}>
            <span className="file-preview-gutter">{index + 1}</span>
            <span className="file-preview-content">
              <LineContent content={line || " "} lang={lang} />
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}

function LineContent({ content, lang }: { content: string; lang: string | null }): JSX.Element {
  if (!lang) {
    return <>{content}</>;
  }
  const tokens = highlightLine(content, lang);
  if (tokens.length === 1 && tokens[0] && !tokens[0].color) {
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
