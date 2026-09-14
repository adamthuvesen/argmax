import { interpretFileChange } from "../lib/fileChange.js";
import {
  displayToolInput,
  isAgentMessageToolName,
  isOpaqueCiphertext
} from "../lib/toolArguments.js";
import {
  displayBashCommand,
  extractOpenablePath,
  getToolTypeBucket,
  isBashLikeTool,
  unwrapBashCommand,
  type ToolCall
} from "../lib/toolCalls.js";
import { isInternalAgentLaunchMetadata } from "../lib/agentLaunch.js";

export const REDUNDANT_INPUT_KEYS = new Set([
  "absolute_path",
  "content",
  "file_path",
  "filePath",
  "filepath",
  "path",
  "relative_path",
  "streamContent",
  "text"
]);
// A diff the provider handed over is drawn by the file-change card below, so
// it is not also an argument. Only redundant once that card is rendering it:
// on any other tool a `patch` or `diff` argument is a value the agent supplied
// and the detail is the only place it appears.
export const RENDERED_DIFF_INPUT_KEYS = new Set([
  ...REDUNDANT_INPUT_KEYS,
  "changes",
  "diff",
  "edits",
  "new_string",
  "newString",
  "old_string",
  "oldString",
  "operation",
  "patch",
  "replace_all",
  "replaceAll",
  "unified_diff"
]);
export const BASH_COMMAND_INPUT_KEYS = ["command", "cmd", "shell_command", "script"] as const;
// Claude's Bash carries `description` + `timeout`; Codex uses `timeout_ms`.
// None of that is a reason to dump the whole input JSON under the command.
export const REDUNDANT_BASH_INPUT_KEYS = new Set([
  ...REDUNDANT_INPUT_KEYS,
  ...BASH_COMMAND_INPUT_KEYS,
  "cwd",
  "dangerouslyDisableSandbox",
  "description",
  "max_output_tokens",
  "run_in_background",
  "runInBackground",
  "timeout",
  "timeout_ms",
  "yield_time_ms"
]);

export function pickString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function visibleInputForTool(tool: ToolCall): Record<string, unknown> {
  let input = tool.inputFull;
  if (isCodexAgentTool(tool)) {
    return displayToolInput(tool.name, input);
  }
  // For Task (sub-agent) tools, drop the `prompt` field — it's a long
  // multi-paragraph instruction that bloats the toggled detail and adds
  // nothing the user can act on. Keep description + subagent_type.
  if (getToolTypeBucket(tool.name) === "agent") {
    input = Object.fromEntries(Object.entries(input).filter(([k]) => k !== "prompt"));
  }
  return displayToolInput(tool.name, input);
}

export function hasNonRedundantInput(
  input: Record<string, unknown>,
  redundantKeys: ReadonlySet<string> = REDUNDANT_INPUT_KEYS
): boolean {
  return Object.keys(input).some((key) => !redundantKeys.has(key));
}

export function nonRedundantInput(
  input: Record<string, unknown>,
  redundantKeys: ReadonlySet<string>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => !redundantKeys.has(key)));
}

export function isCodexAgentTool(tool: ToolCall): boolean {
  const lower = tool.name.toLowerCase();
  return lower === "spawn_agent" || lower === "collab_tool_call";
}

function shortenCommandCwd(command: string, cwd: string | null | undefined): string {
  if (!cwd) return command;
  return command.split(cwd.replace(/\/$/, "")).join(".");
}

export function displayCommandPreview(command: string, cwd: string | null | undefined): string {
  return shortenCommandCwd(displayBashCommand(command), cwd);
}

export function displayCommandFull(command: string, cwd: string | null | undefined): string {
  return shortenCommandCwd(unwrapBashCommand(command), cwd);
}

export function hasVisibleToolOutput(tool: ToolCall, output: string | null): boolean {
  if (output === null || output.trim().length === 0) return false;
  if (isAgentMessageToolName(tool.name) && isOpaqueCiphertext(output)) return false;
  // Claude's SendMessage result is `{success, resumedAgentId, pin}`, not the
  // child's answer. Codex collab ciphertext is already caught above. Leave
  // launch-row receipts alone: those rows exist to open the agent pane.
  if (isAgentMessageToolName(tool.name) && isInternalAgentLaunchMetadata(output)) return false;
  return true;
}

/** True when expanding the row would reveal a payload, leftover arguments, a
 *  file, or nested activity. A command that printed nothing is not a disclosure. */
export function toolCallHasExpandableDetail(
  tool: ToolCall,
  options?: { hasLeadingContent?: boolean }
): boolean {
  const changes = interpretFileChange(tool.name, tool.inputFull);
  if (changes && changes.length > 0) return true;

  const visibleInput = visibleInputForTool(tool);
  const bashCommand = isBashLikeTool(tool.name)
    ? pickString(tool.inputFull, BASH_COMMAND_INPUT_KEYS) ?? tool.inputPreview
    : null;
  const fullCommand = bashCommand ? unwrapBashCommand(bashCommand) : null;
  const showCommandBlock = fullCommand !== null && fullCommand.includes("\n");
  const openable = tool.status !== "error" ? extractOpenablePath(tool.name, tool.inputFull) : null;
  const filePath =
    openable ??
    pickString(tool.inputFull, ["path", "file_path", "filepath", "relative_path", "absolute_path"]);
  const streamContent = pickString(tool.inputFull, ["streamContent", "content", "text"]);
  const canShowFilePreview = Boolean(!changes && filePath && streamContent);
  const isAgent = getToolTypeBucket(tool.name) === "agent";
  const redundantKeys = bashCommand ? REDUNDANT_BASH_INPUT_KEYS : REDUNDANT_INPUT_KEYS;
  const leftoverInput = nonRedundantInput(visibleInput, redundantKeys);
  const showArguments =
    Object.keys(leftoverInput).length > 0 &&
    hasNonRedundantInput(visibleInput, redundantKeys) &&
    (!isAgent || isCodexAgentTool(tool));

  return (
    Boolean(tool.error) ||
    canShowFilePreview ||
    Boolean(openable) ||
    showCommandBlock ||
    showArguments ||
    Boolean(options?.hasLeadingContent) ||
    (hasVisibleToolOutput(tool, tool.output) && !tool.error)
  );
}

/** Output size, once it is big enough that a reader cares. */
export function formatSize(chars: number): string | null {
  if (chars < 1024) return null;
  return `${(chars / 1024).toFixed(1)} kB`;
}

/** How long the call took, from the row's own start/complete events. Sub-100ms
 *  is noise, so it stays off the footer entirely. */
export function formatDuration(startedAt: string, completedAt: string | null): string | null {
  if (!completedAt) return null;
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 100) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
