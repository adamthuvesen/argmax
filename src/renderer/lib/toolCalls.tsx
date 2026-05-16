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

type FineBucket = "read-files" | "read-lists" | "search" | "web" | "edit" | "bash" | "other";

function getFineBucket(name: string): FineBucket {
  const lower = name.toLowerCase();
  if (/bash|shell|exec|terminal|cmd/.test(lower)) return "bash";
  if (/write|edit|create|patch|file[_-]?change/.test(lower)) return "edit";
  if (/search|grep|find|glob/.test(lower)) return "search";
  if (/web|browser|navigate|fetch|url|http/.test(lower)) return "web";
  // Distinguish directory listings ("list", "list_dir", "ls") from file reads
  // ("read", "view", "open", "cat") so the rolled-up headline can read
  // "Explored 1 file, 2 lists" like Codex.
  if (/^ls$|list[_-]?dir|^list$|list_files|list_directory/.test(lower)) return "read-lists";
  if (/read|view|open|cat/.test(lower)) return "read-files";
  if (/list/.test(lower)) return "read-lists";
  return "other";
}

const FINE_BUCKET_ORDER: FineBucket[] = ["read-files", "read-lists", "search", "web", "edit", "bash", "other"];

// (verbForm, compactForm) per bucket. verbForm is used when the bucket is
// the sole bucket OR the first clause of a multi-bucket headline. compactForm
// is used for subsequent clauses — Codex-style "Explored 1 file, 2 lists,
// ran 1 command" emerges by mixing the two.
function clauseForBucket(bucket: FineBucket, n: number, first: boolean): string {
  const plural = (singular: string, pluralWord: string): string => (n === 1 ? singular : pluralWord);
  switch (bucket) {
    case "read-files":
      return first ? `Explored ${n} ${plural("file", "files")}` : `${n} ${plural("file", "files")}`;
    case "read-lists":
      return first ? `Listed ${n} ${plural("directory", "directories")}` : `${n} ${plural("list", "lists")}`;
    case "search":
      return first ? `Searched ${n} ${plural("time", "times")}` : `${n} ${plural("search", "searches")}`;
    case "web":
      return first ? `Fetched ${n} ${plural("URL", "URLs")}` : `${n} ${plural("URL", "URLs")}`;
    case "edit":
      return first ? `Edited ${n} ${plural("file", "files")}` : `${n} ${plural("edit", "edits")}`;
    case "bash":
      return first ? `Ran ${n} ${plural("command", "commands")}` : `ran ${n} ${plural("command", "commands")}`;
    case "other":
      return first ? `Used ${n} ${plural("tool", "tools")}` : `${n} ${plural("tool", "tools")}`;
  }
}

export function describeToolAction(tool: ToolCall): string {
  const bucket = getFineBucket(tool.name);
  const preview = tool.inputPreview;
  const basename = (path: string): string => {
    const trimmed = path.replace(/\/$/, "");
    return trimmed.includes("/") ? trimmed.split("/").pop() ?? trimmed : trimmed;
  };
  switch (bucket) {
    case "bash":
      return preview ? `Ran ${preview}` : "Ran command";
    case "edit":
      return preview ? `Edited ${basename(preview)}` : "Edited file";
    case "read-files":
      return preview ? `Read ${basename(preview)}` : "Read file";
    case "read-lists":
      return preview ? `Listed files in ${basename(preview)}` : "Listed files";
    case "search":
      return preview ? `Searched for ${preview}` : "Searched";
    case "web":
      return preview ? `Fetched ${preview}` : "Fetched URL";
    case "other":
      return preview ? `${tool.name} ${preview}` : tool.name;
  }
}

export function summarizeToolGroup(tools: ToolCall[]): {
  headline: string;
  preview: string;
  currentAction: string | null;
  worstStatus: ToolCall["status"];
} {
  const counts = new Map<FineBucket, number>();
  for (const tool of tools) {
    const b = getFineBucket(tool.name);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const clauses: string[] = [];
  let first = true;
  for (const bucket of FINE_BUCKET_ORDER) {
    const n = counts.get(bucket);
    if (!n) continue;
    clauses.push(clauseForBucket(bucket, n, first));
    first = false;
  }
  const headline = clauses.length > 0 ? clauses.join(", ") : `${tools.length} tool calls`;

  const previewParts: string[] = [];
  // Track explicit truncation so " / …" only renders when we genuinely broke
  // early — the previous shape over-counted because un-iterated tools were
  // conservatively treated as valid, which could append " / …" even when
  // every remaining tool had an empty inputPreview (R-035).
  let truncated = false;
  for (let i = 0; i < tools.length; i++) {
    const raw = tools[i]?.inputPreview;
    if (!raw) continue;
    const candidate = raw.includes("/") ? raw.split("/").pop() ?? raw : raw;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    previewParts.push(trimmed.slice(0, 28));
    if (previewParts.length === 3) {
      truncated = i + 1 < tools.length;
      break;
    }
  }
  const preview = previewParts.join(" / ") + (truncated ? " / …" : "");

  let hasError = false;
  let latestRunning: ToolCall | null = null;
  for (const tool of tools) {
    if (tool.status === "error") hasError = true;
    else if (tool.status === "running") latestRunning = tool;
  }
  const worstStatus: ToolCall["status"] = hasError ? "error" : latestRunning ? "running" : "done";

  // While the group is still running, surface the most recent live tool's
  // action so the collapsed header shows what the agent is doing right now.
  const currentAction = latestRunning ? describeToolAction(latestRunning) : null;

  return { headline, preview, currentAction, worstStatus };
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
  if (/file[_-]?change/.test(lower)) {
    const preview = summarizeFileChanges(input.changes);
    if (preview) return preview;
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

function summarizeFileChanges(changes: unknown): string {
  if (!Array.isArray(changes)) return "";
  const paths = changes
    .map((change) => {
      if (!change || typeof change !== "object") return null;
      const value = (change as Record<string, unknown>).path;
      return typeof value === "string" && value.length > 0 ? value : null;
    })
    .filter((value): value is string => value !== null);
  if (paths.length === 0) return "";
  const [first] = paths;
  if (!first) return "";
  return paths.length === 1 ? first : `${first} +${paths.length - 1}`;
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
  if (lower.includes("write") || lower.includes("edit") || lower.includes("create") || lower.includes("patch") || /file[_-]?change/.test(lower)) {
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
  if (/write|edit|create|patch|file[_-]?change/.test(lower)) return "edit";
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
