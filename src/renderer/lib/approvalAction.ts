/** An approval's action, split the way the row shows it.
 *
 *  A shell approval carries the command itself, and printing it verbatim is
 *  the whole point. Every other tool arrives as `"<ToolName>\n<input JSON>"`
 *  (providers/claude_control.rs builds it that way when the input has no
 *  `command` key), so the raw string is a JSON dump — an AskUserQuestion
 *  request fills twelve wrapped mono lines with escaped quotes. Chat never
 *  prints tool input that way (see toolArguments), and neither does this.
 */
import { toolArguments, type ToolArgument } from "./toolArguments.js";

export type ApprovalAction = {
  /** The command, or the tool name when the command is a tool request. */
  title: string;
  /** Empty for a shell command: its arguments are the command text. */
  args: ToolArgument[];
};

/** A path, a URL, a limit — the arguments you decide on. Nested values (a
 *  question set, a file body, a filter object) are the tool's payload, not the
 *  decision, and printing them is what made this row a JSON dump. */
function scalarInput(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value === null || typeof value !== "object")
  );
}

function parsedInput(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function approvalAction(command: string): ApprovalAction {
  const breakAt = command.indexOf("\n");
  if (breakAt > 0) {
    const input = parsedInput(command.slice(breakAt + 1));
    if (input) {
      return { title: command.slice(0, breakAt).trim(), args: toolArguments(scalarInput(input)) };
    }
  }
  return { title: command, args: [] };
}
