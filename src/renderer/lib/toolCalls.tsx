import { FileText, Globe, Pencil, Search, Terminal, Wrench } from "lucide-react";
import type { JSX } from "react";
import { safeJsonParseRecord } from "../../shared/safeJson.js";
import type { TimelineEvent } from "../../shared/types.js";

export type ToolCall = {
  id: string;
  toolUseId: string;
  name: string;
  inputPreview: string;
  inputFull: Record<string, unknown>;
  output: string | null;
  status: "running" | "done" | "error";
  createdAt: string;
  completedAt: string | null;
  error: string | null;
};

export type ParallelPosition = "start" | "middle" | "end";

export type ToolCallGroup = {
  id: string;
  tools: ToolCall[];
  parallelPositions: Map<string, ParallelPosition>;
  parallelGroupId: Map<string, string>;
};

export type ConversationItem =
  | { kind: "message"; event: TimelineEvent }
  | { kind: "tool"; tool: ToolCall }
  | { kind: "tool-group"; group: ToolCallGroup };

const PARALLEL_WINDOW_MS = 75;

export function buildToolCallGroup(tools: ToolCall[]): ToolCallGroup {
  const parallelPositions = new Map<string, ParallelPosition>();
  const parallelGroupId = new Map<string, string>();
  let cluster: ToolCall[] = [];
  const finalize = (): void => {
    if (cluster.length >= 2) {
      const first = cluster[0];
      const last = cluster[cluster.length - 1];
      if (!first || !last) {
        cluster = [];
        return;
      }
      const groupId = `pg-${first.id}`;
      parallelPositions.set(first.id, "start");
      parallelPositions.set(last.id, "end");
      parallelGroupId.set(first.id, groupId);
      parallelGroupId.set(last.id, groupId);
      for (let i = 1; i < cluster.length - 1; i++) {
        const mid = cluster[i];
        if (!mid) continue;
        parallelPositions.set(mid.id, "middle");
        parallelGroupId.set(mid.id, groupId);
      }
    }
    cluster = [];
  };
  for (const tool of tools) {
    const last = cluster[cluster.length - 1];
    if (!last) {
      cluster.push(tool);
      continue;
    }
    const gap = Date.parse(tool.createdAt) - Date.parse(last.createdAt);
    if (Number.isFinite(gap) && gap <= PARALLEL_WINDOW_MS) {
      cluster.push(tool);
    } else {
      finalize();
      cluster = [tool];
    }
  }
  finalize();
  const firstTool = tools[0];
  return {
    id: firstTool ? `tcg-${firstTool.id}` : "tcg-empty",
    tools,
    parallelPositions,
    parallelGroupId
  };
}

export function summarizeToolGroup(tools: ToolCall[]): { headline: string; preview: string; worstStatus: ToolCall["status"] } {
  const names = tools.map((t) => t.name.toLowerCase());
  const every = (pred: (n: string) => boolean): boolean => names.every(pred);
  let headline = `${tools.length} tool calls`;
  if (every((n) => /read|view|cat|^ls$|list_dir/.test(n))) headline = `Explored ${tools.length} files`;
  else if (every((n) => /bash|shell|exec|terminal/.test(n))) headline = `Ran ${tools.length} commands`;
  else if (every((n) => /grep|search|find|glob/.test(n))) headline = `Searched ${tools.length} times`;
  else if (every((n) => /web|fetch|http|url|browser/.test(n))) headline = `Fetched ${tools.length} URLs`;
  else if (every((n) => /write|edit|patch|create/.test(n))) headline = `Edited ${tools.length} files`;

  const previewParts: string[] = [];
  for (const tool of tools) {
    const raw = tool.inputPreview;
    if (!raw) continue;
    const trimmed = raw.includes("/") ? raw.split("/").pop() ?? raw : raw;
    previewParts.push(trimmed.slice(0, 28));
    if (previewParts.length === 3) break;
  }
  const preview = previewParts.join(", ") + (tools.length > previewParts.length ? ", …" : "");
  const worstStatus: ToolCall["status"] = tools.some((t) => t.status === "error")
    ? "error"
    : tools.some((t) => t.status === "running")
      ? "running"
      : "done";
  return { headline, preview, worstStatus };
}

export function extractToolUseId(payload: Record<string, unknown>): string | null {
  if (typeof payload.id === "string" && payload.id) return payload.id;
  if (typeof payload.call_id === "string" && payload.call_id) return payload.call_id;
  return null;
}

/**
 * Correlate a `command.completed` event back to its `command.started` partner.
 * Each provider keys the correlation differently:
 *   - Claude: `tool_result.tool_use_id` → started `tool_use.id`
 *   - Codex:  `item.completed.id` matches started `item.id`
 *   - Cursor: `tool_call(completed).call_id` matches started `call_id`
 * Checked in that order so Claude's `tool_use_id` (which is *not* the
 * completion's own id) wins over a coincidentally-present `id` field.
 */
export function extractCompletionCorrelationId(payload: Record<string, unknown>): string | null {
  if (typeof payload.tool_use_id === "string" && payload.tool_use_id) return payload.tool_use_id;
  if (typeof payload.id === "string" && payload.id) return payload.id;
  if (typeof payload.call_id === "string" && payload.call_id) return payload.call_id;
  return null;
}

export function extractToolName(payload: Record<string, unknown>): string {
  if (typeof payload.name === "string" && payload.name) return payload.name;
  if (typeof payload.type === "string" && payload.type !== "command.started") return payload.type;
  return "tool";
}

export function extractToolInput(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)) {
    return payload.input as Record<string, unknown>;
  }
  if (typeof payload.arguments === "string") {
    return safeJsonParseRecord(payload.arguments, "toolCalls.arguments");
  }
  return {};
}

export function extractToolInputPreview(name: string, input: Record<string, unknown>): string {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) {
    const cmd = input.command ?? input.cmd;
    if (typeof cmd === "string") return cmd.split("\n")[0]?.slice(0, 72) ?? "";
  }
  const path = input.file_path ?? input.path ?? input.relative_path;
  if (typeof path === "string") return path;
  const query = input.query ?? input.pattern ?? input.search_term;
  if (typeof query === "string") return String(query).slice(0, 72);
  const url = input.url;
  if (typeof url === "string") return url.slice(0, 72);
  // Unknown shape: skip the Object.values[0] fallback — key iteration order
  // is insertion-order for strings but ascending-numeric-first for
  // integer-like keys, so the preview would vary unpredictably with the
  // input shape. Return empty rather than guess.
  return "";
}

export function extractToolOutput(payload: Record<string, unknown>): string | null {
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .map((c: unknown) => (c && typeof c === "object" && "text" in c ? String((c as Record<string, unknown>).text) : ""))
      .filter(Boolean)
      .join("\n");
    return text || null;
  }
  if (typeof payload.output === "string") return payload.output;
  return null;
}

export function detectToolError(payload: Record<string, unknown>): boolean {
  if (payload.is_error === true) return true;
  if (payload.isError === true) return true;
  if (typeof payload.error === "string" && payload.error.length > 0) return true;
  if (payload.error && typeof payload.error === "object") return true;
  const status = payload.status;
  if (typeof status === "string" && /fail|error/i.test(status)) return true;
  return false;
}

export function extractToolError(payload: Record<string, unknown>): string | null {
  if (typeof payload.error === "string" && payload.error.length > 0) return payload.error;
  if (payload.error && typeof payload.error === "object") {
    const errObj = payload.error as Record<string, unknown>;
    if (typeof errObj.message === "string") return errObj.message;
  }
  if (payload.is_error === true || payload.isError === true) {
    const output = extractToolOutput(payload);
    if (output) return output;
  }
  return null;
}

export function extractOpenablePath(name: string, input: Record<string, unknown>): string | null {
  const lower = name.toLowerCase();
  if (!/read|view|cat|write|edit|patch|create|open/.test(lower)) return null;
  for (const key of ["file_path", "filepath", "path", "relative_path", "absolute_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

export function isBashLikeTool(name: string): boolean {
  const lower = name.toLowerCase();
  return /bash|shell|exec|terminal|cmd/.test(lower);
}

export function getToolIcon(name: string): JSX.Element {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("terminal") || lower.includes("exec")) {
    return <Terminal size={13} />;
  }
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create") || lower.includes("patch")) {
    return <Pencil size={13} />;
  }
  if (lower.includes("read") || lower.includes("view") || lower.includes("open") || lower.includes("cat") || lower.includes("list")) {
    return <FileText size={13} />;
  }
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find") || lower.includes("glob")) {
    return <Search size={13} />;
  }
  if (lower.includes("web") || lower.includes("browser") || lower.includes("navigate") || lower.includes("fetch") || lower.includes("url") || lower.includes("http")) {
    return <Globe size={13} />;
  }
  return <Wrench size={13} />;
}

export type ToolTypeBucket = "bash" | "edit" | "read" | "search" | "web" | "other";

export function getToolTypeBucket(name: string): ToolTypeBucket {
  const lower = name.toLowerCase();
  if (/bash|shell|exec|terminal|cmd/.test(lower)) return "bash";
  if (/write|edit|create|patch/.test(lower)) return "edit";
  if (/read|view|open|cat|list/.test(lower)) return "read";
  if (/search|grep|find|glob/.test(lower)) return "search";
  if (/web|browser|navigate|fetch|url|http/.test(lower)) return "web";
  return "other";
}

export function buildGroupIconBuckets(tools: ToolCall[]): ToolTypeBucket[] {
  const seen = new Map<ToolTypeBucket, number>();
  for (const tool of tools) {
    const b = getToolTypeBucket(tool.name);
    seen.set(b, (seen.get(b) ?? 0) + 1);
  }
  return [...seen.keys()].slice(0, 3);
}

export const BUCKET_ICON_NAME: Record<ToolTypeBucket, string> = {
  bash: "bash",
  edit: "write",
  read: "read_file",
  search: "search_files",
  web: "web_fetch",
  other: "tool",
};
