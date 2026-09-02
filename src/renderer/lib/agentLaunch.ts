import { stringValue } from "../../shared/typeGuards.js";
import type { ToolCall } from "./toolCalls.js";

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
    // Not "use SendMessage with to:": Claude Code appends that footer
    // (agentId, SendMessage hint, usage) to every *finished* subagent result
    // too, so matching it re-marked each completed agent as still running
    // whenever the session ran — and a stale running row from an earlier
    // turn suppressed the Thinking cue for the next turn's whole opening gap.
    normalized.includes("do not read or tail this file") ||
    normalized.includes("background agent launched") ||
    normalized.includes("background task launched") ||
    normalized.includes("subagent launched") ||
    normalized.includes("agent launched successfully")
  );
}

/**
 * The two-part label a launch row shows: what the agent was sent to do, plus
 * the codename that identifies it in the tab strip and activity pane. When the
 * provider gave no description (Codex `spawn_agent`), the codename becomes the
 * title so the row is never anonymous.
 *
 * The prompt is deliberately never used. It is a multi-paragraph instruction,
 * and truncating it into a title turned every spawn into a path wall — only the
 * provider's own short `description` is short enough to be a title.
 */
export function agentLaunchLabel(
  tool: ToolCall,
  codename?: string
): { title: string; identity: string | null } {
  const name = trimmedString(codename);
  const description = trimmedString(tool.inputFull.description);
  if (description) return { title: description, identity: name };
  return { title: name ? `Launched ${name}` : "Launched subagent", identity: null };
}

function agentLaunchPreview(tool: ToolCall): string {
  return trimmedString(tool.inputPreview)
    ?? trimmedString(tool.inputFull.description)
    ?? trimmedString(tool.inputFull.prompt)
    ?? "Agent";
}

/** Every launch row names its own state in words, done included: a finished
 *  agent reads "Completed" rather than relying on a glyph to say so. */
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
