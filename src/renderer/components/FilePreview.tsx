import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { EditorView, keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { Code, Eye, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import { LinesSkeleton } from "./LinesSkeleton.js";
import { formatBytes } from "../lib/formatBytes.js";
import { resolveMarkdownImageSrc } from "../lib/markdownImageSrc.js";

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
    case "go":
      return [go()];
    case "rs":
      return [rust()];
    case "sh":
    case "bash":
    case "zsh":
      return [StreamLanguage.define(shell)];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "sql":
      return [sql()];
    case "yaml":
    case "yml":
      return [yaml()];
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
    return <LinesSkeleton rows={18} label="Loading file" className="review-file-skeleton" />;
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
    <div
      className="file-preview"
      data-mode={showRendered ? "rendered" : "source"}
      aria-label={`Preview of ${state.selectedPath}`}
    >
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
          {state.canEdit ? (
            <button
              type="button"
              className="small-icon"
              disabled={!state.isDirty || state.saveState === "saving"}
              aria-label={state.saveState === "saving" ? "Saving file" : "Save file"}
              title="Save file"
              onClick={() => void state.saveFile()}
            >
              <Save size={14} />
            </button>
          ) : null}
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
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              img: ({ src, alt, ...rest }) => {
                const resolved = resolveMarkdownImageSrc(
                  typeof src === "string" ? src : undefined,
                  state.rootPath,
                  state.selectedPath
                );
                if (!resolved) {
                  return <span className="file-preview-broken-image">{alt ?? "image"}</span>;
                }
                return <img src={resolved} alt={alt ?? ""} {...rest} />;
              }
            }}
          >
            {buffer}
          </ReactMarkdown>
        </div>
      ) : (
        <SourceEditor
          path={state.selectedPath}
          value={buffer}
          onChange={state.editFile}
          onSave={state.saveFile}
          saving={state.saveState === "saving"}
          editable={state.canEdit}
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
        <button
          type="button"
          className="small-icon"
          onClick={onReload}
          aria-label="Reload from disk"
          title="Reload from disk"
        >
          <RotateCcw size={12} />
        </button>
        {isDirty ? (
          <button
            type="button"
            className="file-preview-stale-secondary"
            onClick={onKeepMine}
            aria-label="Keep my edits and overwrite on save"
          >
            Keep my edits
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Editor chrome theme — colors read from the same token palette as the rest of
 * the app, so flipping the page theme (light ↔ dark) reflows the editor with
 * no per-theme branch. The `dark` flag is omitted intentionally; CodeMirror
 * derives selection/cursor luminance from `.cm-content`'s computed color.
 */
const editorTheme = EditorView.theme({
  "&": {
    fontSize: "12.5px",
    backgroundColor: "transparent",
    height: "100%",
    color: "var(--text)"
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.5"
  },
  ".cm-content": {
    caretColor: "var(--text)",
    color: "var(--text)"
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--muted)"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--overlay-soft)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--muted-strong)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    background: "var(--selection-bg) !important"
  },
  "&.cm-focused": {
    outline: "none"
  }
});

/**
 * Syntax highlight palette wired to design tokens. The same style serves both
 * themes — `--sage` etc. resolve to the lifted dark-mode variants in dark and
 * the deeper light-mode variants in light, so we never need a second style.
 * Choices favor muted, editorial color over the saturated rainbow CodeMirror
 * ships by default (which reads as bright pastels against warm charcoal).
 */
const editorHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "var(--rose)", fontWeight: "500" },
  { tag: [t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--rose)" },
  { tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName], color: "var(--text)" },
  { tag: [t.function(t.variableName), t.labelName], color: "var(--amber)" },
  { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--amber)" },
  { tag: [t.definition(t.name), t.separator], color: "var(--text-soft)" },
  { tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.modifier, t.self, t.namespace],
    color: "var(--amber)" },
  { tag: [t.operator, t.special(t.string), t.punctuation], color: "var(--muted-strong)" },
  { tag: [t.url, t.escape, t.regexp, t.link], color: "var(--sage)" },
  { tag: [t.meta, t.comment], color: "var(--muted)", fontStyle: "italic" },
  { tag: t.tagName, color: "var(--rose)" },
  { tag: [t.attributeName], color: "var(--amber)" },
  { tag: [t.attributeValue, t.string], color: "var(--sage)" },
  { tag: t.heading, fontWeight: "600", color: "var(--text)" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--amber)" },
  { tag: t.invalid, color: "var(--rose)" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" }
]);

const editorSyntaxHighlighting = syntaxHighlighting(editorHighlightStyle);

function SourceEditor({
  path,
  value,
  onChange,
  onSave,
  saving,
  editable
}: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => Promise<void>;
  saving: boolean;
  editable: boolean;
}): JSX.Element {
  const handleSave = useCallback((): boolean => {
    void onSave();
    // CodeMirror's keymap expects the command to return `true` when handled so
    // the keystroke doesn't fall through to the browser (which would otherwise
    // pop the Save Page dialog).
    return true;
  }, [onSave]);

  const extensions = useMemo<Extension[]>(
    () =>
      editable
        ? [
            ...editorLanguageFor(path),
            keymap.of([{ key: "Mod-s", preventDefault: true, run: handleSave }]),
            editorTheme,
            editorSyntaxHighlighting,
            EditorView.lineWrapping
          ]
        : [...editorLanguageFor(path), editorTheme, editorSyntaxHighlighting, EditorView.lineWrapping],
    [path, handleSave, editable]
  );

  return (
    <div className="file-preview-editor" data-saving={saving ? "true" : "false"}>
      <CodeMirror
        value={value}
        onChange={onChange}
        editable={editable}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: editable,
          highlightSelectionMatches: false,
          autocompletion: false
        }}
        aria-label={`Editor for ${path}`}
      />
    </div>
  );
}
