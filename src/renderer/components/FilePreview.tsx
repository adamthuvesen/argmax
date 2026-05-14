import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { EditorView, keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { Code, Eye, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";

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

/**
 * CodeMirror language extensions keyed by file extension. We pull a small
 * lane of common languages by default — adding more is a one-line entry.
 * Files we don't recognise still render in CodeMirror as plain text with
 * line numbers + standard editing affordances; we just skip syntax tokens.
 */
function editorLanguageFor(path: string | null): Extension[] {
  if (!path) return [];
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: true })];
    case "ts":
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "css":
    case "scss":
    case "less":
      return [css()];
    case "html":
    case "htm":
      return [html()];
    case "json":
    case "json5":
      return [json()];
    case "md":
    case "markdown":
      return [markdown()];
    case "py":
      return [python()];
    default:
      return [];
  }
}

export function FilePreview({ state }: { state: WorkspaceFilesState }): JSX.Element {
  const markdownFile = isMarkdownPath(state.selectedPath);
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

  const showRendered = markdownFile && mode === "rendered";
  const buffer = state.buffer ?? preview.content;
  const dirtyMarker = state.isDirty ? "•" : "";

  return (
    <div className="file-preview" aria-label={`Preview of ${state.selectedPath}`}>
      <div className="file-preview-heading">
        <strong>
          {state.selectedPath}
          {dirtyMarker ? (
            <span className="file-preview-dirty" aria-label="Unsaved changes" title="Unsaved changes">
              {" "}
              {dirtyMarker}
            </span>
          ) : null}
        </strong>
        <div className="file-preview-heading-meta">
          <span className="file-preview-size">{formatBytes(preview.size)}</span>
          {markdownFile ? (
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
      {state.externalChange ? (
        <StaleBanner
          isDirty={state.isDirty}
          onReload={state.reloadFile}
          onKeepMine={state.dismissExternalChange}
        />
      ) : null}
      {state.saveError ? (
        <p className="file-preview-save-error" role="alert">
          {state.saveError}
        </p>
      ) : null}
      {showRendered ? (
        <div className="file-preview-markdown markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{buffer}</ReactMarkdown>
        </div>
      ) : (
        <SourceEditor
          path={state.selectedPath}
          value={buffer}
          onChange={state.editFile}
          onSave={state.saveFile}
          saving={state.saveState === "saving"}
        />
      )}
    </div>
  );
}

function StaleBanner({
  isDirty,
  onReload,
  onKeepMine
}: {
  isDirty: boolean;
  onReload: () => void;
  onKeepMine: () => void;
}): JSX.Element {
  // When the buffer isn't dirty, there's nothing to lose by reloading — but we
  // still surface the banner so the user notices the external edit instead of
  // having content silently shift under them.
  const headline = isDirty
    ? "This file changed on disk while you were editing."
    : "This file changed on disk.";
  return (
    <div className="file-preview-stale" role="alert" aria-label="File changed on disk">
      <span className="file-preview-stale-text">{headline}</span>
      <div className="file-preview-stale-actions">
        <button type="button" className="small-icon" onClick={onReload} aria-label="Reload from disk">
          <RotateCcw size={12} />
          <span>Reload from disk</span>
        </button>
        {isDirty ? (
          <button
            type="button"
            className="small-icon"
            onClick={onKeepMine}
            aria-label="Keep my edits and overwrite on save"
          >
            <span>Keep my edits</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Light, paper-toned theme for the editor — keeps it visually flush with the
 * surrounding panel rather than fighting Argmax's light-only design tokens.
 * Sizing matches the previous `<pre>` ladder so swapping editors doesn't
 * reshuffle layout.
 */
const editorTheme = EditorView.theme(
  {
    "&": {
      fontSize: "12.5px",
      backgroundColor: "transparent",
      height: "100%"
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.5"
    },
    ".cm-content": {
      caretColor: "var(--text)"
    },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "var(--muted)"
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(0, 0, 0, 0.025)"
    },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "var(--muted-strong)"
    },
    "&.cm-focused": {
      outline: "none"
    }
  },
  { dark: false }
);

function SourceEditor({
  path,
  value,
  onChange,
  onSave,
  saving
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => Promise<void>;
  saving: boolean;
}): JSX.Element {
  const handleSave = useCallback((): boolean => {
    void onSave();
    // CodeMirror's keymap expects the command to return `true` when handled so
    // the keystroke doesn't fall through to the browser (which would otherwise
    // pop the Save Page dialog).
    return true;
  }, [onSave]);

  const extensions = useMemo<Extension[]>(
    () => [
      ...editorLanguageFor(path),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: handleSave }
      ]),
      editorTheme,
      EditorView.lineWrapping
    ],
    [path, handleSave]
  );

  return (
    <div className="file-preview-editor" data-saving={saving ? "true" : "false"}>
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightSelectionMatches: false,
          autocompletion: false
        }}
        aria-label={`Editor for ${path}`}
      />
    </div>
  );
}
