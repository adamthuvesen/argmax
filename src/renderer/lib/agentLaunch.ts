import { stringValue } from "../../shared/typeGuards.js";
import type { ToolCall } from "./toolCalls.js";

const GENERIC_ROLES = new Set([
  "general-purpose",
  "general_purpose",
  "generalpurpose",
  "default",
  "unspecified"
]);

function trimmedString(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Detect provider-internal launch confirmations (e.g. Claude's async task
 * launch receipt) that indicate the subagent was dispatched into the
 * background rather than returning its final completed result.
 */
export function isInternalAgentLaunchMetadata(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("this tool result is internal metadata") ||
    normalized.includes("async agent launched successfully") ||
    normalized.includes("use sendmessage with to:") ||
    normalized.includes("do not read or tail this file") ||
    normalized.includes("background agent launched") ||
    normalized.includes("background task launched") ||
    normalized.includes("subagent launched") ||
    normalized.includes("agent launched successfully")
  );
}

function rawSubagentType(tool: ToolCall): string | null {
  return trimmedString(tool.inputFull.subagent_type) ?? trimmedString(tool.inputFull.subagentType);
}

function titleCaseRole(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

/** Human role from `subagent_type` / `subagentType`. Generic roles are skipped. */
export function agentRoleLabel(tool: ToolCall): string | null {
  const raw = rawSubagentType(tool);
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/_/g, "-");
  if (GENERIC_ROLES.has(normalized) || GENERIC_ROLES.has(raw.toLowerCase())) return null;
  return titleCaseRole(raw);
}

/**
 * Visible parent-chat label. The prompt and description live in the activity
 * pane: dumping them here turned every spawn into a truncated path wall.
 */
export function agentLaunchTitle(codename?: string): string {
  const name = trimmedString(codename);
  return name ? `Launched ${name}` : "Launched subagent";
}

function agentLaunchPreview(tool: ToolCall): string {
  return trimmedString(tool.inputPreview)
    ?? trimmedString(tool.inputFull.description)
    ?? trimmedString(tool.inputFull.prompt)
    ?? "Agent";
}

/** Parent-row status hint. A completed launch says nothing: the pane owns status. */
export function agentLaunchStatusHint(status: ToolCall["status"]): string | null {
  return status === "done" ? null : agentStatusLabel(status);
}

export function agentStatusLabel(status: ToolCall["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "done":
      return "Completed";
    case "error":
      return "Failed";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function agentLaunchAriaLabel(tool: ToolCall, agentCodename?: string): string {
  const preview = agentLaunchPreview(tool);
  if (agentCodename) return `Started agent ${agentCodename} — ${preview}`;
  return `Started agent ${preview}`;
}
