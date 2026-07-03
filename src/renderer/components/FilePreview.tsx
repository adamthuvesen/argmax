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
import { HighlightStyle, StreamLanguage, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { search } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import type { SyntaxNode } from "@lezer/common";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import {
  Decoration,
  EditorView,
  keymap,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import CodeMirror from "@uiw/react-codemirror";
import { Code, Eye, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkspaceFilesState } from "../hooks/useReviewState.js";
import { LinesSkeleton } from "./LinesSkeleton.js";
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
    return <p className="review-empty review-empty-preview">Select a file to preview.</p>;
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
        ? "Binary file — not previewable."
        : preview.reason === "too-large"
          ? "File too large to preview."
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
    fontSize: "var(--text-sm)",
    backgroundColor: "transparent",
    height: "100%",
    color: "var(--text)"
  },
  ".cm-scroller": {
    fontFamily: "var(--font-code)",
    lineHeight: "1.65"
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
    backgroundColor: "transparent"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--muted-strong)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    background: "var(--selection-bg) !important"
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--amber) 34%, transparent)",
    outline: "1px solid color-mix(in oklab, var(--amber) 48%, transparent)"
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--accent) 36%, transparent)",
    outline: "1px solid color-mix(in oklab, var(--accent) 58%, transparent)"
  },
  ".cm-codex-definition": {
    color: "var(--syntax-definition)"
  },
  ".cm-codex-type": {
    color: "var(--syntax-type)"
  },
  ".cm-codex-constant": {
    color: "var(--syntax-constant)"
  },
  ".cm-codex-variable": {
    color: "var(--syntax-variable)"
  },
  ".cm-codex-keyword": {
    color: "var(--syntax-keyword)"
  },
  "&.cm-focused": {
    outline: "none"
  }
});

/**
 * Codex-like syntax palette wired to theme tokens: red imports/flow, violet
 * definitions and calls, green strings, blue builtins/types, orange constants
 * and self-like bindings.
 */
const editorHighlightStyle = HighlightStyle.define([
  {
    tag: [t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.keyword],
    color: "var(--syntax-keyword)"
  },
  {
    tag: [t.definitionKeyword, t.definition(t.name), t.definition(t.variableName), t.function(t.variableName)],
    color: "var(--syntax-definition)"
  },
  { tag: [t.className, t.labelName, t.annotation], color: "var(--syntax-definition)" },
  { tag: [t.typeName, t.standard(t.name), t.standard(t.variableName)], color: "var(--syntax-type)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: "var(--syntax-type)" },
  { tag: [t.self, t.constant(t.name), t.constant(t.variableName)], color: "var(--syntax-variable)" },
  { tag: [t.color, t.changed, t.modifier, t.macroName], color: "var(--syntax-constant)" },
  { tag: [t.attributeName, t.special(t.variableName)], color: "var(--syntax-constant)" },
  { tag: [t.attributeValue, t.string, t.docString, t.character], color: "var(--syntax-string)" },
  { tag: [t.url, t.escape, t.regexp, t.link], color: "var(--syntax-type)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [t.meta, t.processingInstruction], color: "var(--syntax-comment)" },
  { tag: [t.name, t.variableName, t.deleted, t.propertyName, t.namespace], color: "var(--text)" },
  { tag: [t.operator, t.punctuation, t.separator, t.derefOperator], color: "var(--muted-strong)" },
  { tag: t.tagName, color: "var(--syntax-keyword)" },
  { tag: t.heading, fontWeight: "600", color: "var(--text)" },
  { tag: t.invalid, color: "var(--syntax-keyword)" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" }
]);

const editorSyntaxHighlighting = syntaxHighlighting(editorHighlightStyle);

const pythonDefinitionDecoration = Decoration.mark({ class: "cm-codex-definition" });
const pythonKeywordDecoration = Decoration.mark({ class: "cm-codex-keyword" });
const pythonTypeDecoration = Decoration.mark({ class: "cm-codex-type" });
const pythonConstantDecoration = Decoration.mark({ class: "cm-codex-constant" });
const pythonVariableDecoration = Decoration.mark({ class: "cm-codex-variable" });
const pythonSemanticPattern =
  /@[A-Za-z_]\w*|\b[A-Z][A-Z0-9_]{2,}\b|\b(?:from|str|int|bool|dict|list|tuple|set|float|bytes|object|type|None|True|False|self)\b/g;

function isInsideStringOrComment(view: EditorView, from: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(from, 1); node; node = node.parent) {
    if (/String|Comment/.test(node.name)) return true;
  }
  return false;
}

const pythonSemanticDecorator = new MatchDecorator({
  regexp: pythonSemanticPattern,
  decorate(add, from, to, match, view) {
    if (isInsideStringOrComment(view, from)) return;
    const token = match[0];
    if (token.startsWith("@")) {
      add(from + 1, to, pythonDefinitionDecoration);
    } else if (token === "from") {
      add(from, to, pythonKeywordDecoration);
    } else if (token === "self") {
      add(from, to, pythonVariableDecoration);
    } else if (/^[A-Z][A-Z0-9_]{2,}$/.test(token)) {
      add(from, to, pythonConstantDecoration);
    } else {
      add(from, to, pythonTypeDecoration);
    }
  },
  boundary: /[^@\w]/
});

const pythonSemanticHighlighting = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = pythonSemanticDecorator.createDeco(view);
    }

    update(update: ViewUpdate): void {
      this.decorations = pythonSemanticDecorator.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (plugin) => plugin.decorations
  }
);

function semanticHighlightingFor(path: string): Extension[] {
  return path.endsWith(".py") ? [pythonSemanticHighlighting] : [];
}

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
            ...semanticHighlightingFor(path),
            keymap.of([{ key: "Mod-s", preventDefault: true, run: handleSave }]),
            search({ top: true }),
            editorTheme,
            editorSyntaxHighlighting,
            EditorView.lineWrapping
          ]
        : [
            ...editorLanguageFor(path),
            ...semanticHighlightingFor(path),
            search({ top: true }),
            editorTheme,
            editorSyntaxHighlighting,
            EditorView.lineWrapping
          ],
    [path, handleSave, editable]
  );

  return (
    <div className="file-preview-editor" data-saving={saving ? "true" : "false"}>
      <CodeMirror
        value={value}
        onChange={onChange}
        editable={editable}
        readOnly={!editable}
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: false,
          highlightSelectionMatches: false,
          syntaxHighlighting: false,
          autocompletion: false
        }}
        aria-label={`Editor for ${path}`}
      />
    </div>
  );
}
