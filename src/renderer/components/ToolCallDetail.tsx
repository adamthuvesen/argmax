import { FileText, PanelRight } from "lucide-react";
import { useMemo, type JSX, type ReactNode } from "react";
import { interpretFileChange } from "../lib/fileChange.js";
import {
  displayBashCommand,
  extractOpenablePath,
  getToolTypeBucket,
  isBashLikeTool,
  type ToolCall
} from "../lib/toolCalls.js";
import { FileChangeCard } from "./FileChangeCard.js";
import type { FileChipOpenOptions } from "./FileChip.js";

const MAX_INLINE_CONTENT_CHARS = 2400;
const MAX_OUTPUT_CHARS = 3000;
const REDUNDANT_INPUT_KEYS = new Set([
  "absolute_path",
  "content",
  "file_path",
  "filepath",
  "path",
  "relative_path",
  "streamContent",
  "text"
]);
const BASH_COMMAND_INPUT_KEYS = ["command", "cmd", "shell_command", "script"] as const;
const REDUNDANT_BASH_INPUT_KEYS = new Set([
  ...REDUNDANT_INPUT_KEYS,
  ...BASH_COMMAND_INPUT_KEYS,
  "cwd",
  "max_output_tokens",
  "timeout_ms",
  "yield_time_ms"
]);

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
  if (isCodexAgentTool(tool)) return tool.inputFull;
  // For Task (sub-agent) tools, drop the `prompt` field — it's a long
  // multi-paragraph instruction that bloats the toggled detail and adds
  // nothing the user can act on. Keep description + subagent_type.
  if (getToolTypeBucket(tool.name) !== "agent") return tool.inputFull;
  return Object.fromEntries(Object.entries(tool.inputFull).filter(([k]) => k !== "prompt"));
}

function hasNonRedundantInput(
  input: Record<string, unknown>,
  redundantKeys: ReadonlySet<string> = REDUNDANT_INPUT_KEYS
): boolean {
  return Object.keys(input).some((key) => !redundantKeys.has(key));
}

function isCodexAgentTool(tool: ToolCall): boolean {
  const lower = tool.name.toLowerCase();
  return lower === "spawn_agent" || lower === "collab_tool_call";
}

function displayCommand(command: string, cwd: string | null | undefined): string {
  const unwrapped = displayBashCommand(command);
  if (!cwd) return unwrapped;
  return unwrapped.split(cwd.replace(/\/$/, "")).join(".");
}

export function ToolCallDetail({
  tool,
  workspaceCwd,
  onOpenFile,
  leadingContent
}: {
  tool: ToolCall;
  workspaceCwd?: string | null;
  onOpenFile?: (path: string, opts?: FileChipOpenOptions) => void;
  leadingContent?: ReactNode;
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
  const bashCommand = isBashLikeTool(tool.name)
    ? pickString(tool.inputFull, BASH_COMMAND_INPUT_KEYS) ?? tool.inputPreview
    : null;
  const openable = tool.status !== "error" ? extractOpenablePath(tool.name, tool.inputFull) : null;
  const filePath = openable ?? pickString(tool.inputFull, ["path", "file_path", "filepath", "relative_path", "absolute_path"]);
  const streamContent = pickString(tool.inputFull, ["streamContent", "content", "text"]);
  const canShowFilePreview = !changes && filePath && streamContent;
  // The Started-agent row already shows the description; its only "raw input"
  // is description + subagent_type (prompt is dropped), so the box is pure
  // noise — and renders as an empty-looking shell before the sub-agent runs.
  // Skip it for Claude-style Task agents and let the detail collapse to
  // children/output. Codex spawn_agent rows are different: the prompt and
  // receiver thread ids are the only detail Codex gives us, so keep those
  // expandable instead of making the row feel dead.
  const isAgent = getToolTypeBucket(tool.name) === "agent";
  const showRawInput =
    Object.keys(visibleInput).length > 0 &&
    hasNonRedundantInput(visibleInput, bashCommand ? REDUNDANT_BASH_INPUT_KEYS : REDUNDANT_INPUT_KEYS) &&
    (!isAgent || isCodexAgentTool(tool));
  const rawInput = showRawInput ? (
    <details className="tool-call-raw-input">
      <summary>Input</summary>
      <pre className="tool-call-code">{JSON.stringify(visibleInput, null, 2)}</pre>
    </details>
  ) : null;

  if (changes && changes.length > 0) {
    return (
      <div className="tool-call-detail">
        {tool.error ? (
          <div className="tool-call-section">
            <p className="tool-call-section-label">Error</p>
            <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
          </div>
        ) : null}
        {rawInput}
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
    Boolean(bashCommand) ||
    showRawInput ||
    Boolean(leadingContent) ||
    (Boolean(tool.output) && !tool.error);
  if (!hasMainContent) return null;

  return (
    <div className="tool-call-detail">
      {leadingContent}
      {bashCommand ? (
        <div className="tool-call-section">
          <p className="tool-call-section-label">Command</p>
          <div className="tool-call-command-line" title={displayCommand(bashCommand, workspaceCwd)}>
            <code>{displayCommand(bashCommand, workspaceCwd)}</code>
          </div>
        </div>
      ) : null}
      {tool.error ? (
        <div className="tool-call-section">
          <p className="tool-call-section-label">Error</p>
          <pre className="tool-call-code tool-call-code--error">{tool.error}</pre>
        </div>
      ) : null}
      {canShowFilePreview ? (
        <section className="tool-call-section tool-call-file-preview" aria-label={`Preview of ${filePath}`}>
          <p className="tool-call-section-label">Preview</p>
          <pre className="tool-call-code tool-call-code--file-preview">
            {streamContent.length > MAX_INLINE_CONTENT_CHARS
              ? `${streamContent.slice(0, MAX_INLINE_CONTENT_CHARS)}\n...`
              : streamContent}
          </pre>
        </section>
      ) : openable && !tool.output ? (
        <div className="tool-call-resource-row">
          <FileText size={14} aria-hidden="true" />
          <code title={openable}>{displayPath(openable, workspaceCwd)}</code>
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
        </div>
      ) : null}
      {tool.output && !tool.error ? (
        <div className="tool-call-section">
          <p className="tool-call-section-label">
            Output
            {tool.output.length > MAX_OUTPUT_CHARS ? (
              <span className="tool-call-section-meta">
                {" "}— showing first {MAX_OUTPUT_CHARS.toLocaleString()} of {tool.output.length.toLocaleString()} chars
              </span>
            ) : null}
          </p>
          <pre
            className={`tool-call-code${isBashLikeTool(tool.name) ? " tool-call-code--terminal" : ""}`}
          >
            {tool.output.length > MAX_OUTPUT_CHARS ? `${tool.output.slice(0, MAX_OUTPUT_CHARS)}\n…` : tool.output}
          </pre>
        </div>
      ) : null}
      {rawInput}
    </div>
  );
}
