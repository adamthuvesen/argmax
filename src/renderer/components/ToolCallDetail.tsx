import { FileText, PanelRight } from "lucide-react";
import { useMemo, type JSX } from "react";
import { interpretFileChange } from "../lib/fileChange.js";
import { extractOpenablePath, getToolTypeBucket, isBashLikeTool, type ToolCall } from "../lib/toolCalls.js";
import { FileChangeCard } from "./FileChangeCard.js";
import type { FileChipOpenOptions } from "./FileChip.js";

const MAX_INLINE_CONTENT_CHARS = 2400;

function pickString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function displayPath(path: string, cwd: string | null | undefined): string {
  if (!cwd) return path;
  const normalized = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path.startsWith(normalized)) return path.slice(normalized.length);
  if (path === cwd) return path;
  return path;
}

function visibleInputForTool(tool: ToolCall): Record<string, unknown> {
  // For Task (sub-agent) tools, drop the `prompt` field — it's a long
  // multi-paragraph instruction that bloats the toggled detail and adds
  // nothing the user can act on. Keep description + subagent_type.
  if (getToolTypeBucket(tool.name) !== "agent") return tool.inputFull;
  return Object.fromEntries(Object.entries(tool.inputFull).filter(([k]) => k !== "prompt"));
}

export function ToolCallDetail({
  tool,
  workspaceCwd,
  onOpenFile
}: {
  tool: ToolCall;
  workspaceCwd?: string | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
}): JSX.Element | null {
  const openFile = (path: string): void => {
    if (onOpenFile) {
      onOpenFile(path);
      return;
    }
    if (!window.argmax) return;
    void window.argmax.system
      .openPath({ path, ...(workspaceCwd ? { cwd: workspaceCwd } : {}) })
      .catch(() => undefined);
  };
  const changes = useMemo(
    () => interpretFileChange(tool.name, tool.inputFull),
    [tool.name, tool.inputFull]
  );
  const visibleInput = visibleInputForTool(tool);
  const openable = tool.status !== "error" ? extractOpenablePath(tool.name, tool.inputFull) : null;
  const filePath = openable ?? pickString(tool.inputFull, ["path", "file_path", "filepath", "relative_path", "absolute_path"]);
  const streamContent = pickString(tool.inputFull, ["streamContent", "content", "text"]);
  const canShowFilePreview = !changes && filePath && streamContent;
  // The Agent (Task) banner already shows the description; its only "raw input"
  // is description + subagent_type (prompt is dropped), so the box is pure
  // noise — and renders as an empty-looking shell before the sub-agent runs.
  // Skip it for agents and let the detail collapse to nothing until output
  // (the sub-agent's result) arrives.
  const isAgent = getToolTypeBucket(tool.name) === "agent";
  const showRawInput = Object.keys(visibleInput).length > 0 && !isAgent;

  if (changes && changes.length > 0) {
    return (
      <div className="tool-call-detail">
        {tool.error ? (
          <div className="tool-call-section">
            <p className="tool-call-section-label">Error</p>
            <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
          </div>
        ) : null}
        {changes.map((change, index) => (
          <FileChangeCard
            change={change}
            key={`${change.path}-${index}`}
            workspaceCwd={workspaceCwd ?? null}
            onOpenFile={onOpenFile}
          />
        ))}
      </div>
    );
  }

  // Nothing worth a panel (a Task still spawning, say) → render no detail at
  // all rather than an empty bordered box hanging under the banner.
  const hasMainContent =
    Boolean(tool.error) ||
    Boolean(canShowFilePreview) ||
    Boolean(openable) ||
    showRawInput ||
    (Boolean(tool.output) && !tool.error);
  if (!hasMainContent) return null;

  return (
    <div className="tool-call-detail">
      {tool.error ? (
        <div className="tool-call-section">
          <p className="tool-call-section-label">Error</p>
          <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
        </div>
      ) : null}
      {canShowFilePreview ? (
        <section className="tool-call-file-preview" aria-label={`Preview of ${filePath}`}>
          <header className="tool-call-file-preview-header">
            <FileText size={14} aria-hidden="true" />
            <code title={filePath}>{displayPath(filePath, workspaceCwd)}</code>
            <button
              className="tool-call-open-button"
              type="button"
              onClick={() => openFile(filePath)}
              aria-label={`Open ${filePath}`}
            >
              <PanelRight size={11} aria-hidden="true" />
              <span>Open</span>
            </button>
          </header>
          <pre className="tool-call-file-preview-content">
            {streamContent.length > MAX_INLINE_CONTENT_CHARS
              ? `${streamContent.slice(0, MAX_INLINE_CONTENT_CHARS)}\n...`
              : streamContent}
          </pre>
        </section>
      ) : openable ? (
        <button
          className="tool-call-open-button"
          type="button"
          onClick={() => openFile(openable)}
          aria-label={`Open ${openable}`}
          title={openable}
        >
          <PanelRight size={11} aria-hidden="true" />
          <span>Open</span>
        </button>
      ) : null}
      {showRawInput ? (
        <div className="tool-call-section">
          <p className="tool-call-section-label">Raw input</p>
          <pre className="tool-call-code">{JSON.stringify(visibleInput, null, 2)}</pre>
        </div>
      ) : null}
      {tool.output && !tool.error ? (
        <div className="tool-call-section">
          <p className="tool-call-section-label">
            Output
            {tool.output.length > 3000 ? (
              <span className="tool-call-section-meta">
                {" "}— showing first 3,000 of {tool.output.length.toLocaleString()} chars
              </span>
            ) : null}
          </p>
          <pre
            className={`tool-call-code${isBashLikeTool(tool.name) ? " tool-call-code--terminal" : ""}`}
          >
            {tool.output.length > 3000 ? `${tool.output.slice(0, 3000)}\n…` : tool.output}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
